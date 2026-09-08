# 真实调度与 Git Eval 接线计划

## 不是聊天模拟

`dev-build-workflow-cases.json` 与 `checkpoint-workflow-cases.json` 使用项目 SelectedCases 的 `version: 1` / `kind: codex-workflow` 外形。`input` 与 `expected.criteria` 是待编写 adapter 的测试合同，不是给 Skill 新增 runtime 状态协议。

包括本次新增 `adaptive-review-workflow-cases.json` 在内的三组暂不注册到插件 manifest，防止指向不存在的脚本。不能仅因 JSON 可解析就报告这些 Eval 可运行或通过。

## 复用当前 Engine

参考当前仓库 `plugins/codex-enhance/skills/codex-subagent-guide/evals/codex-workflow-adapter.mjs` 的 prepare/grade 模式。Engine 启动真实模型并采集协作证据；插件 adapter 不另起 Codex 进程、不造 rollout，不使用 GitHub Actions。

`prepare` 应做：在隔离工作区写入 case input.workspaceFiles，按 setup 建立真实临时 Git 历史，解析本次实际 OID，配置允许写入的角色和实际模型；确保 worker 可读 Spec/work 与 candidate Skill。用户授权只限测试工作区，不允许真实远端操作。

`grade` 应消费 Engine 提供的证据和实际 Git/源码状态。分别检查真实 agent 启动与终态、任务依赖、写入归属、测试退出结果、Review 目标与权限范围。路径与角色的映射由 prepare 记录，不能按最终回复中出现几次“子代理”评分。

当前 Engine 的 `workflow-evidence.json` 提供 `collaborationCalls`、`leafCalls`、`threadGraph`、`skillLoads` 和 `workspaceDiff`；清理证据在 `termination.appServerProcessTreeCleanupConfirmed` 与 `cleanup.isolatedCodexHomeRemoved`。现有 adapter 从这些字段整理协作时间线。是否能归因到每个 worker 的具体文件修改，需要在当前 Engine 输出中确认；若没有，增加 adapter 可验证证据或在该项标为 unknown，不能凭 final claim 判定 pass。不要为了一个测试在 production Skill 增加输出字段。

## 需要额外支持的恢复用例

`resume-active-worker-no-duplicate` 需要 Engine 能保留一个真实运行中的 worker 或提供真实不可确认状态。当前包仅给出机制探测设计；没有实现该安排，不计入已可执行 case。无法建立环境就标为 unavailable，而非把模拟 trace 当行为通过。

## 建议注册方式

adapter 实现后，在 dev-build/evals/manifest.json 追加 `kind: codex-workflow` 的 suite，provider 使用项目当前公开合同的 `type`、`command`、`allowedModels`。模型名单由项目可用配置决定，本包不写死模型。

先运行顺序worker、milestone范围、最终累计范围三个用例，再扩大到并发、恢复和历史整理。每个用例保留实际 trace、验证结果、用户介入、tokens 与耗时；对比当前版本和候选，不设置未验证的百分比发布门槛。

## 自适应 Review adapter 增量

新增六条 case 的字段仍属于 Eval adapter，不进入 Skill 的输入输出协议。命令和模型白名单在实际项目环境确定，本稿没有新增 provider 实现或并发执行服务。

### Prepare

1. 用 workspaceFiles 创建隔离仓库；含 steps 的恢复 case 实际创建提交并运行对应验证，将真实 OID/结果补入工作记录。
2. 把历史次数、旧 Review 清楚标为测试入场历史；它们不能计入“被测 agent 已真实执行的轮数”。
3. 为正常路径启用真实实现 worker 和独立 reviewer。需要 unavailable 的用例使用 Engine 真正的权限/能力拒绝，不伪造一个模型审查报告。
4. 用户授权只限隔离本地环境。保留现有 checkpoint/no-push 约束，不扩展真实 GitHub 权限。
5. 原稿与新版使用相同 fixture、授权和工具条件；不为了产生三轮结果人为按轮投喂预制 finding。

### Grade

从 Engine 实际协作、工具结果、写入和 verifier 退出码核对：

- 是否真实发生本轮修改与独立 Review，而不是共享上下文切换了 Skill。
- 当前一批首次产品修改是否占用额度；多个 worker 是同一批，不把每次 edit/test 调用算一个正式轮次。
- 在已有 used 历史上累计，宏重入和阶段改名不能重置；预算已耗尽不得发生下一批产品修改。
- 与 reviewer 分歧时是否提交证据而不是静默删除；高风险加审是否针对明确缺口。
- 真正修复后独立公共行为测试是否通过；未关闭有效 blocker 不得被 clean 标签覆盖。

若 Engine 不能归因写入或区分修复批次，相关项标 unknown；先用单一工作项/显式 review 边界缩小测试，再决定是否需要最小测试侧观测。不得把 fixture 预设的计数或 agent 自述当作事实，不在生产 Skill 中加 JSON receipt 来迁就 grader。

`incomplete-does-not-refund-started-batch` 允许两条路径：预检即发现能力缺失、未修改则保留原 used；已修改才发现不可用，则这轮已占用。必须分别记录覆盖，不能把前一路径的通过冒充后一路径通过。

### 运行顺序

先跑“真实第二批局部修复”和“耗尽后的宏恢复”；再跑多 worker 共享一批、针对性高风险审查、incomplete 故障和报告冲突。先验证 adapter 自身的事件关联，再讨论策略成效。
