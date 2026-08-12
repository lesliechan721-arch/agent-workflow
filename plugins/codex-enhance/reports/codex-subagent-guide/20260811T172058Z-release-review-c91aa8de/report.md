# Codex Subagent Guide 发布评审

本文件是迁移后保留的正式人读报告。文中的 batch 和 run ID 用于说明历史依据；对应机械输出、scorecard 和 trace 不在当前源码树中保留。

## 执行结论

- **Skill：** `codex-subagent-guide`
- **模式：** release
- **方向：** aligned
- **发布结论：** pass
- **加权分：** 90.4/100（excellent）
- **Coverage：** 100%
- **Confidence：** 0.99（high）
- **一句话结论：** 所有发布门禁通过；没有 P0/P1。真实 Codex 证据覆盖触发、V1/V2 routing、无 Skill 基线和生命周期。当前仅有两个 Eval P2。

本次遵守用户的明确要求：未受修改影响的模型用例不重跑。评审复用了同一 materialized subject digest 的 Trigger、Lifecycle 和已通过 Routing 证据，再补齐缺失 Routing case。报告没有把这些证据描述成中央 runner 的单轮 complete bundle。

## 评审合同

| 项目 | 来源事实 | 状态 |
| --- | --- | --- |
| 目标问题 | 在委派已经获准后，稳定选择 role、自定义参数、上下文、等待和条件清理 | known |
| 已观察失败 | routing 原始参数缺失、全历史错误参数、部分历史错误近似、stdin 等待超时、macOS 凭据隔离和报告输出问题 | known |
| 成功标准 | 正确加载；正确 spawn 参数；无法表达时 fail closed；timeout 不等于失败；真实终态后才完成和清理 | known |
| 目标环境 | Codex CLI；本次真实环境为 `codex-cli 0.147.0`、`gpt-5.6-luna`、Full Access managed process mode | known |
| 范围外 | 不授予委派权限；不决定是否应启用多 Agent；不替代专用生命周期 owner；不覆盖 Claude 模型行为 | known |
| 相邻 Skill | 授权 Skill、专用委派 owner、项目 `AGENTS.md`、其它 Skill 的明确授权 | known |
| 发布要求 | required Trigger、Routing、Lifecycle 有真实模型证据；按用户要求使用可追溯累积等价证据 | known |

## 当前官方来源

本次在 2026-08-12 重新核对以下 current-check 来源：

- [Agent Skills Specification](https://agentskills.io/specification)：frontmatter、name、description、兼容性、渐进式披露和相对引用。
- [Best practices for skill creators](https://agentskills.io/skill-creation/best-practices)：真实执行、控制校准、范围和上下文负载。
- [Optimizing skill descriptions](https://agentskills.io/skill-creation/optimizing-descriptions)：现实正负例、near miss、多次运行和 trigger rate。
- [Evaluating skill output quality](https://agentskills.io/skill-creation/evaluating-skills)：clean context、baseline、trace 和机械 assertion。
- [Using scripts in skills](https://agentskills.io/skill-creation/using-scripts)：脚本依赖、接口和相对路径。

客户端字段和生命周期判断使用当前工具 schema、Codex 0.147.0 运行 trace 和 materialized role 文件。没有把客户端字段当作通用 Agent Skills 规范。

## 发布门禁

| Gate | 状态 | 严重性 | 证据 | 原因 |
| --- | --- | --- | --- | --- |
| package-validity | pass | P0 | 作者校验；四类 subjects | frontmatter、目录/name、动态制品和 profile 有效 |
| critical-artifacts | pass | P0 | renderer、4 roles、manifest、required runners | 核心文件存在，且 deterministic tests 通过 |
| goal-alignment | pass | P0 | `SKILL.md:3,11` | Skill 只管理已授权委派，不自行授予权限 |
| capability-validity | pass | P0 | V1/V2 routing 与 lifecycle trace | 当前 Codex 能力和参数已经真实验证 |
| safety-permissions | pass | P0 | Trigger 13/13；fail-closed cases | 授权、专用 owner 和禁止 spawn 的边界有效 |
| architecture-ownership | pass | P1 | `SKILL.md:27-31`；lifecycle 1/1 | Runtime 管理真实状态；Skill 只保存稳定策略 |
| release-evidence | pass | P1 | Trigger 39 runs；Routing 216 runs；Lifecycle 1 run | 累积证据覆盖全部 required behavior，模型和 subject digest 一致 |

`release-evidence` 的 pass 只适用于本次用户定义的“不重跑无影响用例”合同。中央 runner 尚未生成一份单轮 complete release bundle。该产品缺口记录为 F-001。

## 维度评分

| 维度 | 权重 | 分数 / 5 | 置信度 | 主要证据 | 结论 |
| --- | ---: | ---: | --- | --- | --- |
| 规范与包完整性 | 7 | 5.0 | high | author validator；materialized subjects | 包和最终制品有效 |
| 问题基础与价值 | 8 | 4.5 | high | current 106/108；baseline 86/108 | Skill 有 18.5 个百分点的运行增量 |
| 调用、触发与 Pointer | 12 | 4.5 | high | validation 7/7；sanity 6/6 | 正例、near miss 和显式边界稳定 |
| 范围与组合性 | 8 | 4.5 | high | `SKILL.md:3,11`；composition fixture | 授权和 owner 分层清楚 |
| 指令与完成边界 | 12 | 4.5 | high | Routing 18 cases；Lifecycle 1/1 | 参数、上下文、终态和清理可检查 |
| 信息层级 | 12 | 5.0 | high | final Skill 31 行，约 380 tokens | 必要策略短；环境事实未复制进正文 |
| 架构职责 | 10 | 4.0 | high | lifecycle trace；runtime tool state | 自然语言状态风险为 medium，不阻断 |
| 脚本 | 8 | 4.5 | high | plugin:test 13/13；全仓 976 tests | 确定性逻辑已脚本化并有回归 |
| 资源 | 5 | 5.0 | high | 静态检查无断裂、深链或孤立 runtime 资源 | runtime 与 eval 资产分离正确 |
| Evals | 10 | 4.0 | high | Trigger、Routing、Lifecycle、baseline、raw trace | 覆盖充分；累积组合和词法断言仍可改进 |
| 可靠性与兼容性 | 4 | 4.5 | high | Codex 0.147.0；managed cleanup；file credentials | 当前目标环境验证充分 |
| 可维护性 | 4 | 4.5 | medium | renderer 单一事实源；增量提交；无静态触发改写 | 修改集中在正确 owner |

## 主要优点

- Description 明确区分“已授权”“无专用 owner”和“本 Skill 不授予权限”。
- 核心 Skill 很短。它没有复制 schema 的合法枚举、真实 agent 状态或 role 模型配置。
- preset 与 custom 有明确边界。role 缺失或参数冲突时会停止，不猜测或降级。
- 上下文规则覆盖 clean、部分历史、全历史和无法精确表达的情况。
- 等待规则把 timeout 与失败分开。只有 runtime 终态才算完成。
- Eval 会读取原始 `spawn_agent` arguments。最终文案和简化事件不能替代参数证据。
- Trigger validation 和 sanity 的所有正负例都稳定通过。禁止加载或禁止 spawn 的负例为零容忍。
- Full Access managed process mode 和 file-only credential 配置消除了之前的 macOS 钥匙串阻断。

## Required findings

没有 P0 或 P1。

## 非阻断 findings

| ID | 严重性 | 证据类型 | 维度 | 位置 | 观察 | 最小建议 |
| --- | --- | --- | --- | --- | --- | --- |
| F-001 | P2 | observed, normative | Evals | `20260811T152944Z-294f98f2` 和增量 routing 报告 | 中央 runner 不能恢复并组合已通过 suite/case 为一份 complete bundle | 增加严格的 resume/composition 模式；校验 model、config、subject digest、runs、case 集和 provenance |
| F-002 | P2 | observed | Evals | `project_rule_partial_context`、`fixed_role_custom_conflict` | 两个正确停止且零 spawn 的 run 被 final-message 子串断言误判 | 保留零 spawn 硬断言；解释质量改用结构化或语义判断，不堆同义词 |

F-002 不代表 Skill 行为失败。两个 run 都正确停止，且没有调用 `spawn_agent`。因此核心安全断言为 108/108；词法完整断言使总 current run 结果为 106/108。

## Invocation 与 Pointer 审计

| Pointer | 目标材料 | 触发 branch | 意图是否前置 | 重复同义 branch | 重复正文身份 | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| `SKILL.md` description | Skill 全文 | 委派已授权，且没有专用 owner | 是 | 否 | 否 | validation/sanity 13/13 | 保持不变 |
| description 负边界 | 不加载 Skill | 只判断、讨论或建议是否委派 | 是 | 否 | 否 | 负例 load/spawn rate 均为 0 | 保持不变 |
| `agents/openai.yaml` default prompt | 显式 `$codex-subagent-guide` | 用户显式要求使用 Skill | 是 | 否 | 否 | explicit boundary 3/3 | 保持不变 |
| compatibility | 当前 Codex schema 和四个 roles | 能力可用性检查 | 是 | 否 | 否 | Codex 0.147.0 trace | 保持客户端限定 |

Skill 正文没有外部 runtime pointer。大型 eval 资产不是执行时参考，因此不需要从 `SKILL.md` 指向它们。

## 信息层级图

| 内容 | 类型 | branch | 当前位置 | 每次需要 | 到达方式 / 事实源 | 完成边界 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| 只使用公开 schema | environment-lookup | 每次 | `SKILL.md:11` | 是 | 当前工具 schema | 不推断未公开字段 | 保持 |
| 四类任务到 `agent_type` | in-file-reference | preset | renderer 注入的 Spawn 表 | 是 | final Skill | 选一个 role 或停止 | 保持 |
| custom 字段作用域 | in-file-step | custom | Spawn 参数段 | 是 | 当前 schema | 只传显式支持字段 | 保持 |
| clean context 默认值 | in-file-step | 普通委派 | `SKILL.md:19-21` | 是 | 当前 schema | message 自包含 | 保持 |
| partial/full history 限制 | in-file-reference | 明确继承 | `SKILL.md:23` | 否 | 当前 schema | 无法精确表达则停止 | 保持 inline gotcha |
| wait 与终态 | in-file-step | 结果必需 | `SKILL.md:27-29` | 否 | runtime wait/result | 真实终态后完成 | 保持 |
| 条件清理 | in-file-step | cleanup 工具存在 | `SKILL.md:31` | 否 | 当前 schema | 结果保留且后代不再需要 | 保持 |
| role model/effort | environment-lookup | materialize/install | plugin config 与 role TOML | 否 | renderer/config schema | 最终 role 文件为事实源 | 不复制进 Skill |

## 完成边界审计

| 步骤或规则 | 当前完成条件 | 清楚 | 可检查 | 要求充分 | 覆盖充分 | 过早完成风险 | 建议 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| preset 选择 | 只传一个已安装 `agent_type` | 是 | 是，原始调用参数 | 是 | 是 | 低 | 保持 |
| custom 参数 | 只传明确作用于子任务且 schema 支持的字段 | 是 | 是，原始调用参数 | 是 | 是 | 低 | 保持 |
| context | clean 为默认；继承必须精确表达 | 是 | 是，fork 参数 | 是 | 是 | 低 | 保持 |
| wait | timeout 后若结果仍必要则继续；真实终态才完成 | 是 | 是，timeline | 是 | 是 | medium | 由 lifecycle eval 继续保护 |
| cleanup | 结果已保留，目标及后代不再需要 | 是 | 是，timeline/tool state | 是 | 是 | 低 | 不增加罕见竞态文案 |

## 架构与职责

- **Skill owner：** 委派后的 role 分类、custom/preset 策略、clean context 默认、等待和清理的不变量。
- **Schema/Client owner：** 字段名、类型、合法值、可用 role、V1/V2 表达能力和冲突规则。
- **Runtime owner：** agent 真实状态、终态、timeout、通知、后代关系和清理能力。
- **Script owner：** renderer、配置替换、原始参数解析、timeline 解析、隔离、机械评分和报告。
- **Role owner：** 只完成初始 message 中的任务，并返回证据、验证和阻塞。
- **Eval/issue owner：** 罕见乱序、强制取消、不存在清理工具和低概率恢复分支。
- **自然语言状态机风险：** medium。静态 source 模板因占位符和生命周期词计为 high heuristic；四个 materialized final Skill 均为 moderate。真实 timeline 通过。

## 脚本与资源

- `render-artifacts.mjs` 是 role 分类、默认 model/effort 和 final Skill 片段的单一生成源。
- routing harness 只接受原始 rollout 参数。它对 transport 瞬断有有限重试，但不重试普通行为错误。
- lifecycle harness 从 collaboration timeline 评分，不用最终文案代替工具证据。
- `plugin:test` 为 13/13。全仓回归为 76/76 files、976/976 tests。构建和作者校验通过。
- 静态检查未发现缺失引用、深链、孤立 runtime 资源或 role 协议复制。
- Eval 资产体积较大，但它们不进入 runtime Skill context。该分离正确。

## Evals 与证据

### Trigger

- validation：7/7 case 通过，每个 3 runs。
- sanity：6/6 case 通过，每个 3 runs。
- 39 个 runs 无 execution error。
- 正例的 load/spawn rate 为 1。禁止 load/spawn 的 near miss rate 为 0。
- 总成本：889,500 tokens；平均 22,808 tokens/run；平均 23.2 秒/run。

### Routing

- 18/18 case 有证据。
- 每个 case 包含 V1/V2 × with/without Skill × 3 runs。
- 共 72 个 aggregate results、216 个模型 runs。
- 36/36 with-skill aggregate results 通过。
- with-skill 单次断言：106/108（98.1%）。
- without-skill baseline：86/108（79.6%）。
- 增量：18.5 个百分点。
- 原始参数缺失：0。Skill load 证据缺失：0。
- 核心 fail-closed/零 spawn 行为：108/108。两个失败只来自 F-002 的词法解释断言。
- 总运行时长为 3,721,357 ms；平均 17.2 秒/run。早停 routing 没有可靠 token usage，因此不报告 token 总量。

Routing 证据映射：

| Case | Run ID |
| --- | --- |
| `simple_preset_fresh` | `20260811T152944Z-294f98f2` |
| `readonly_complexity_not_simple` | `20260811T155657Z-a499eb6a` |
| `general_preset_fresh` | `20260811T161210Z-26bc4d4a` |
| `complex_preset_fresh` | `20260811T161610Z-c97ac3e6` |
| `planning_review_preset_fresh` | `20260811T162025Z-d8e3d6a1` |
| `custom_model_only` | `20260811T162333Z-d4b0479a` |
| `custom_effort_only` | `20260811T162753Z-b2a19749` |
| `custom_agent_type_only` | `20260811T163346Z-3a1a23c1` |
| `custom_model_and_effort` | `20260811T163626Z-8461b5f2` |
| `custom_override_scoped_to_subtask` | `20260811T164009Z-01d6f07e` |
| `partial_preset` | `20260811T164404Z-71c0bc81` |
| `partial_custom_model` | `20260811T164757Z-804cf969` |
| `full_history` | `20260811T152606Z-90589c3b` |
| `full_history_custom_override` | `20260811T165450Z-9ef44fae` |
| `project_rule_partial_context` | `20260811T165827Z-3d933dae` |
| `skill_rule_full_history_context` | `20260811T170358Z-9f6f98a1` |
| `missing_preset_role` | `20260811T170634Z-f4a8223d` |
| `fixed_role_custom_conflict` | `20260811T170941Z-b42a9989` |

所有映射报告都使用 Luna，`source.inScopeDirty=false`，且 materialized `subjects` 标准化后相同。最后的 README 数字修复只改 eval 文档，不改 materialized Skill 或模型输入。

### Lifecycle

- `wait_for_terminal_result`：1/1 通过。
- 首次 wait、timeout 后继续、真实终态和条件清理的 timeline assertion 全部通过。
- 运行时长约 36.0 秒。该早停 timeline 没有可靠 token usage。

### 证据限制

- 中央 full run `20260811T152944Z-294f98f2` 因 routing 中途 timeout 为 incomplete。
- 本次按用户要求没有重跑已通过 Trigger/Lifecycle，也没有重跑已有有效 Routing case。
- `trigger-composition` 是 standard 诊断 suite，不是 release-required；本次没有真实模型结果。
- 行为证据只覆盖 Codex，不覆盖 Claude。

## Delta 与 sediment

- 原 P1 `writeFile` 报告错误已关闭。
- strict Trigger 发布门禁、负例零容忍和 standard composition fixture 已分层。
- macOS 钥匙串问题通过 file-only 凭据配置和 Full Access managed process 流程关闭。
- V1 原始参数、全历史 `agent_type`、部分历史近似和 routing 等待超时均有 observed 修复和回归证据。
- 全仓 plugin eval 默认模型改为 Luna；显式 `--model` 仍可覆盖。
- 报告目录不再污染 source dirty 状态，因此可按 case 增量补证据。
- 没有根据静态 review 修改 Trigger 正面条件。
- Core Skill 只增加了真实行为失败所需的上下文限制。主要增长在 Eval 和报告层。没有建议继续增加罕见生命周期正文。
- **净变化：** larger，但增长集中在确定性 Eval 和持久证据；runtime Skill 保持小。

## 最小改进路线

### Now — 发布阻断

无。

### Next — 高价值改进

1. 实现 F-001 的严格 resume/composition 模式。它应让 interrupted release eval 只补缺失 case，并产出一份可机械验证的 complete bundle。
2. 实现 F-002 的结构化解释 assertion。不要继续添加同义词列表。

### Later — 诊断或产品工作

1. 只有在准备真实多 Skill 发布场景时，再运行 `trigger-composition` 模型诊断。
2. 若 Codex 早停接口以后提供稳定 token usage，再补 Routing/Lifecycle 成本指标。
3. 罕见乱序、强制取消和不存在清理工具分支留在 Eval/issue。没有新 observed 失败时，不增加 Skill 文案。

## Unknowns

- 没有 Claude 模型行为证据。这不属于当前 Codex-only 发布目标。
- 没有中央单轮 complete bundle。累积证据的逐项 provenance 已在本报告保存。
- 没有本轮 `trigger-composition` 真实模型结果。该 suite 不是 release-required。
- Routing/Lifecycle 早停 run 没有稳定 token usage。

## 停止结论

当前应停止修改。所有 P0/P1 门禁已通过。剩余问题属于 Eval P2，不要求扩张核心 Skill 文案。只有新的真实失败、当前规范变化、工具 schema 变化，或需要中央可恢复 release bundle 时，才应开始下一轮修改。
