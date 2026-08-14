# codex-subagent-guide Skill 完整评审报告

## 结论

- **Skill：** `codex-subagent-guide`
- **模式：** `full`
- **方向：** `aligned`
- **复杂度：** `proportionate`
- **可缩减程度：** `minor`
- **发布结论：** `provisional`
- **加权总分：** 91.4 / 100
- **原始质量带：** `excellent`
- **有效质量带：** `excellent`
- **覆盖率：** 100%
- **置信度：** `high`，指数 0.96
- **一句话结论：** 当前 Skill 的 trigger、V1/V2 routing 和正常终态流程全部通过，但 release corpus 缺少 Case Admission metadata，且真实 lifecycle 没有覆盖 timeout 后再次等待；因此总体证据仍是 provisional。

本报告评审提交 `4efcc101e1b0b217ede0f17d1fa5b366879578fc`。主批次是 `20260813T171846Z-full-review-20260814-7fb4fdc7`，生产源 digest 是 `sha256:81ca86a95ab4390fed18c200e5dff9805a042fe299a0f99e34750648ee5dd143`，`inScopeDirty=false`。

- **正式发布授权：** 已授权。用户要求推送报告。
- **README 登记授权：** 未授权。本次不运行 `review:release`，不修改 README。

## 评审合同

| 项目 | 从材料提取的结论 | 状态 |
| --- | --- | --- |
| 目标问题 | 在委派已授权后，稳定选择 role 和参数，管理 context、wait 和安全 cleanup；不授予委派权限。 | known |
| 已观察失败 | 当前 Skill 行为没有机械失败。Eval corpus 缺少 admission metadata；lifecycle timeout 分支未被真实运行覆盖。 | known |
| 成功标准 | 已授权且无专用 owner；按最终交付物选 role；显式字段不丢失；默认 clean context；只认 runtime 终态；安全 cleanup。 | known |
| 目标环境或客户端 | Codex CLI 0.147.0，模型 `gpt-5.6-luna`，provider `openai-oauth`；支持 V1/V2 schema 和四个 guide role。 | known |
| 范围外事项 | 判断是否授权委派、专用 Skill 已拥有的委派、只讨论多 Agent、插件安装和配置说明。 | known |
| 相邻 Skill | `codex-explore` 是大型只读事实探索的专用 owner；适用时由它完整管理流程。 | known |
| 发布要求 | manifest 要求四个 materialization profile、trigger validation/sanity、routing 和 lifecycle。用户要求 full 评审、完整 eval 和正式报告发布。 | known |

## 发布门禁

| Gate ID | 状态 | 严重性 | Finding IDs | 证据 | 原因 |
| --- | --- | --- | --- | --- | --- |
| package-validity | pass | P0 | — | validator、build、tests、artifact digest | 包和最终制品有效。 |
| critical-artifacts | pass | P0 | — | Skill、4 roles、renderer、manifest | 核心材料存在。 |
| goal-alignment | pass | P0 | — | `SKILL.md:3,11-31` | 只管理已授权的通用委派。 |
| capability-validity | pass | P0 | — | V1/V2 routing、materialized roles | 所需能力存在。 |
| safety-permissions | pass | P0 | — | authorization gate、exact context、runtime terminal | 不静默授予权限。 |
| architecture-ownership | pass | P1 | — | owner 审计、runtime trace | runtime 管理状态；renderer 管理配置。 |
| release-evidence | pass | P1 | — | 8/8 target；所有 suite 机械通过 | 真实运行、重复运行、routing baseline 和 trace 齐全。 |
| eval-validity | unknown | P1 | — | F-GUIDE-001、F-GUIDE-002 | oracle authority 和 timeout branch 证据不足。 |
| eval-change-safety | not_applicable | P1 | — | 本轮没有修改 Skill | 无 eval-driven production change。 |

## 优点

- build、插件 validator、9 个插件脚本文件和 18 个 Node 测试通过。
- project/user、default/non-default subject 均成功生成；artifact digest 匹配。
- release trigger validation 7/7、sanity 6/6。load 和 spawn 的 recall/specificity 都是 100%。
- routing 18/18 case 通过。两个 profile 的 current 结果是 36/36；108 次 current run 全部通过。
- without-Skill routing baseline 是 72/108。Skill 把机械正确率从 66.7% 提高到 100%。
- current routing 总时长 2,546,379 ms；baseline 是 3,009,710 ms。current 平均约 23.6 秒，baseline 约 27.9 秒。
- 正常 lifecycle trace 使用 `timeout_ms=600000`，等待到真实终态，再返回 `retryLimit=3`。

## 必须修复的问题

无 P0/P1 finding。`eval-validity=unknown` 使结论保持 provisional；这不是被审 Skill 的 P1 缺陷。

## 非阻断问题

| ID | 严重性 | 证据类型 | 维度 | 位置 | 观察 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| F-GUIDE-001 | P2 | structural | evals | `evals/trigger-cases.json`、`evals.json`、`lifecycle-evals.json` | strict validator 分别报告 176、127 和 8 个错误。大部分 release case 没有 error policy、层级、role、provenance、场景族、前提和 oracle。 | 使用已合格的 `trigger-composition-cases.json` 作为本地格式，为所有 release-counted case 补 admission metadata。 |
| F-GUIDE-002 | P2 | observed, structural | evals | `run-lifecycle-evals.mjs:114-119`；eval README | 真实 trace 的唯一 wait 为 `timed_out=false`。`timeout_followed_by_wait` 仍因空数组 `.every()` 返回 true；README 却声称 suite 验证 timeout 后继续等待。 | 增加一个可确定触发 timeout 的独立 case，并要求至少一个 timeout 和后续 wait；或收窄当前 suite 的声明。 |

## 未知项

| ID | 维度 | 描述 | 所需证据 |
| --- | --- | --- | --- |
| U-GUIDE-001 | minimum_control | 首次等待至少 10 分钟的精确默认值没有独立消融。 | 比较更短、10 分钟和更长窗口的假失败、轮询次数、完成时间和中断响应。 |
| U-GUIDE-002 | problem_value | routing baseline 证明调用正确性和时间差，但没有最终任务质量和 token 差。 | 让代表任务执行到最终结果，比较 with/without Skill 的质量、token、时间和方差。 |

## 维度评分

| 维度 | 权重 | 分数 | 置信度 | 证据 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- | --- |
| 规范与包完整性 | 6 | 5.0 | high | validator、build、tests、profiles | — | — | 包完整。 |
| 问题基础与实际价值 | 8 | 4.5 | high | current 108/108；baseline 72/108 | — | U-GUIDE-002 | 增量价值明确，缺 final outcome/token。 |
| 调用策略、触发条件与 Context Pointer | 10 | 5.0 | high | release trigger 全部通过 | — | — | 授权和 near-miss 稳定。 |
| 范围、边界与组合性 | 8 | 5.0 | high | authorization/owner gate；routing | — | — | 通用 owner 边界清楚。 |
| 程序与完成边界 | 10 | 5.0 | high | routing 18/18；normal lifecycle | — | — | 参数、context 和终态标准清楚。 |
| 最小充分控制与模型自由度 | 14 | 3.5 | medium | 最小控制审计 | — | U-GUIDE-001 | 控制紧凑，精确等待值待消融。 |
| 信息层级、资源与渐进式披露 | 10 | 5.0 | high | renderer、schema/runtime lookup | — | — | 信息放置正确。 |
| 职责归属与自然语言状态机风险 | 10 | 5.0 | high | owner 审计、agent-only monitoring | — | — | 状态由 runtime 管理。 |
| 脚本与确定性自动化 | 7 | 5.0 | high | renderer、18 tests、5 个 `--help` | — | — | 自动化充分。 |
| Eval 设计、Oracle 有效性与修改安全 | 9 | 3.0 | high | 8/8 target；216 routing runs；strict validation；lifecycle trace | F-GUIDE-001, F-GUIDE-002 | — | 证据广，但仍是诊断级。 |
| 可靠性、安全与兼容性 | 4 | 5.0 | high | V1/V2、profiles、runtime terminal | — | — | 声明已验证。 |
| 剪枝、事实源与变更纪律 | 4 | 5.0 | high | 31 行模板、单一 renderer | — | — | production 结构紧凑。 |

## 调用与 Context Pointer 审计

| Pointer | 目标材料 | 触发 branch | 意图是否前置 | 是否重复同义 branch | 是否重复正文身份 | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| frontmatter description | 已授权、无专用 owner、需要实际执行的通用委派 | authorization；discussion-only；specialized-owner | 是 | 否 | 否 | release load recall/specificity 100% | 保持。 |
| `agents/openai.yaml` default prompt | 用户显式调用 `$codex-subagent-guide` | explicit invocation | 是 | 否 | 否 | explicit boundary 3/3 load、0/3 spawn | 保持。 |
| compatibility | 当前 schema 和四个 bundled roles | spawn/wait/cleanup | 是 | 否 | 否 | V1/V2 routing、4 profiles | 保持环境 lookup。 |

## 最小有效控制审计

### 最小行为合同

1. 只在委派已授权且没有专用 owner 时运行。
2. 只用当前 schema 公开的字段和 role；显式 task-scoped 字段必须完整保留，否则停止。
3. 按最终交付物选择 preset；只读不自动等于 simple。
4. 默认 clean context 和自包含 message；只有必要且可精确表达时才继承。
5. 不用 full history 近似最近 N 轮。
6. 只有父代理需要结果时才 wait；只认 runtime 终态。
7. 只用 agent tools 监控；结果和必要后代都不再需要时才 cleanup。

### 控制面

| Signal | Count / observation | Risk |
| --- | ---: | --- |
| Mandatory stages | authorization/owner、role/schema、context、wait/cleanup | medium。 |
| Hard gates | 已授权、无专用 owner、schema 可精确表达 | high；必须保留。 |
| Fixed intermediate artifacts | 0 | low。 |
| Prohibitions | 不降级、不近似 context、不伪造终态、不用旁路监控、不提前 cleanup | medium。 |
| Conditional branches | preset/custom、inheritance、wait、cleanup | medium。 |
| Fixed output fields | 0；spawn message 只规定语义内容 | low。 |

### 必要性映射与简化候选

| 当前行为块 | 改变的行为 | 依据 | 当前控制类型 | 模型默认能否处理 | 处理建议 | 删除或放宽风险 |
| --- | --- | --- | --- | ---: | --- | --- |
| authorization gate | 防止 Skill 自行授予权限 | project boundary | invariant | 否 | keep-invariant | 高。 |
| specialized owner 优先 | 防止双重生命周期 owner | composition policy | invariant | 否 | keep-invariant | 高。 |
| schema 为准、显式字段保留 | 防止非法或降级调用 | routing 108/108 | invariant | 否 | keep-invariant | 高。 |
| 四个 preset | 稳定 role 选择 | current/baseline delta | default | 部分 | keep-default | 中。 |
| clean context、自包含 message | 降低隐式依赖和泄露 | routing | default | 部分 | keep-default | 中。 |
| 精确 inheritance | 防止 full-history 近似 | schema 边界 | invariant | 否 | keep-invariant | 高。 |
| 首次至少 10 分钟 | 降低短轮询和假失败 | 静态原则、normal trace | default | 未知 | needs-ablation | 未知。 |
| timeout 非失败、只认终态 | 防止提前完成 | runtime fact | invariant | 否 | keep-invariant | 高。 |
| agent-only monitoring | 防止旁路状态机 | architecture | invariant | 否 | keep-invariant | 高。 |
| 安全 cleanup | 防止结果或后代丢失 | lifecycle | invariant | 否 | keep-invariant | 高。 |

## 信息层级图

| 内容 | 类型 | 适用 branch | 当前位置 | 是否每次需要 | 到达 pointer 或环境事实源 | 最小控制结论 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| authorization 和 owner gate | in-file-step | 所有调用 | description | 是 | 用户、AGENTS.md、specialized Skill | keep-invariant | 保持。 |
| preset/custom 和 role 表 | in-file-step | spawn | generated `Spawn 参数` | 是 | renderer | keep-default/invariant | 保持。 |
| context 选择 | in-file-step | spawn | `SKILL.md:17-23` | 是 | current schema | keep-default/invariant | 保持。 |
| wait 和 cleanup | in-file-reference | 需要结果时 | `SKILL.md:25-31` | 否 | runtime status | mixed | 等待值待消融。 |
| 字段和 role 存在性 | environment-lookup | spawn | schema/materialized roles | 否 | Codex | keep-invariant | 不缓存。 |
| terminal、timeout、后代 | environment-lookup | wait/cleanup | runtime | 否 | agent tools | keep-invariant | 不用旁路推断。 |

## 完成边界审计

| 步骤或规则集 | 当前标准 | 清楚 | 可检查 | 要求充分 | 覆盖完整 | 提前完成风险 | 建议 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| authorization/owner | 已授权且无 specialized owner | 是 | 是 | 是 | 是 | 高 | 保持。 |
| role/fields | preset 按交付物；custom 字段完整可用 | 是 | 是 | 是 | 是 | 中 | 保持。 |
| context | 默认 clean；继承必要且可精确表达 | 是 | 是 | 是 | 是 | 中 | 保持。 |
| wait | 父代理需要结果；runtime 未终态则未完成 | 是 | 是 | 是 | 是 | 高 | 保持。 |
| cleanup | 结果已保存，目标和后代都不再需要 | 是 | 是 | 是 | 是 | 高 | 保持。 |

## 架构与职责归属

- **Skill 负责的策略：** authorization 前提、specialized owner 优先、role/default、context、wait 和 cleanup 原则。
- **Schema 或客户端负责的事实：** `agent_type`、model、reasoning、fork 和 wait 字段及合法值。
- **Runtime 负责的状态：** agent 是否存在、active/terminal、timeout、通知和后代关系。
- **脚本候选：** role 表、默认模型和等待配置已由 renderer 生成；不新增 runtime 状态脚本。
- **仅属于 role 的约束：** 子代理只执行 message 中的任务并返回结果。
- **仅属于 eval 或 issue 的问题：** case metadata、timeout fixture 和 assertion。
- **自然语言状态机风险：** `low`。Inspector 给最终 Skill `medium` heuristic 信号，但没有本地状态表或旁路状态。

## 脚本与资源

- **已有脚本或正确省略：** renderer 生成四个 guide role 和最终 Skill；eval runner 处理 trigger、routing 和 lifecycle。
- **接口、依赖和安全质量：** build、validator、18 tests 通过；五个 agent-facing eval 入口的 `--help` 安全返回 0。
- **模型仍在重复的确定性逻辑：** 无。role 配置和机械参数断言已脚本化。
- **Reference 和 asset 可达性：** runtime Skill 无必读 reference 或 asset。
- **重复：** source 使用 placeholder；最终 Skill 只有一份 role 表。
- **Scattering 与 co-location：** production policy 在 Skill；生成逻辑在单一 renderer；eval 与 owner 同目录。
- **不必要缓存的环境事实：** 未发现。
- **过期或孤立资源：** 未发现 production 孤立资源。Eval metadata 缺口见 F-GUIDE-001。

## Eval Case Audit

### 目标和错误代价

| Suite | Optimization policy | False-negative cost | False-positive cost | 判定 |
| --- | --- | --- | --- | --- |
| release trigger | unknown | unknown | unknown | corpus 没有 policy metadata。 |
| release routing | unknown | unknown | unknown | corpus 没有 policy metadata。 |
| release lifecycle | unknown | unknown | unknown | corpus 没有 policy metadata。 |
| non-release composition | critical | high | critical | 已记录，但本批次没有运行。 |

### Eval 门禁

| Gate | 状态 | 证据 | 原因 |
| --- | --- | --- | --- |
| eval-validity | unknown | strict validator；lifecycle trace | 机械 oracle 大体合理，但 authority metadata 和 timeout branch 不完整。 |
| release-evidence | pass | 8/8 covered；release outcome passed | 当前行为、baseline、重复运行和正常 lifecycle trace 完整。 |
| eval-change-safety | not_applicable | 无 production change | 本轮不接受 eval-driven Skill 修改。 |

### Suite 构成

| 指标 | 数量或判定 |
| --- | ---: |
| release cases | 32：trigger 13、routing 18、lifecycle 1 |
| recorded scenario families | 0，release corpus 未记录 |
| recorded representative/regression/boundary roles | 0，release corpus 未记录 |
| non-release composition cases with metadata | 5，2 个 scenario family |
| stale / ambiguous cases | 无已确认 stale；32 个 release case 的 admission 状态未记录 |

### Trigger 二元决策结果

| 指标 | 当前结果 | Baseline / previous | 解释 |
| --- | ---: | ---: | --- |
| Skill-load positive recall | 27/27 = 100% | 无 | 正例都加载。 |
| Skill-load false-negative rate | 0% | 无 | — |
| Skill-load negative specificity | 12/12 = 100% | 无 | near-miss 都不加载。 |
| Skill-load false-positive rate | 0% | 无 | — |
| spawn positive recall | 21/21 = 100% | 无 | 已授权实际委派稳定。 |
| spawn false-negative rate | 0% | 无 | — |
| spawn negative specificity | 18/18 = 100% | 无 | discussion/explicit boundary/existing cleanup 不额外 spawn。 |
| spawn false-positive rate | 0% | 无 | — |

### Behavior、outcome 和 cost 证据

| Scenario family | With Skill | Baseline | Quality delta | Token/time delta | 方差 | 证据强度 |
| --- | --- | --- | ---: | ---: | --- | --- |
| V1/V2 routing | 108/108 runs | 72/108 runs | +33.3 percentage points | current 23.6 s/run；baseline 27.9 s/run；token unavailable | 3 runs/profile/case | high mechanical |
| normal terminal lifecycle | 1/1 | 无 | unknown | 40.6 s；62,430 input、484 output tokens | 1 run | medium |
| timeout continuation | 未观察 | 无 | unknown | unknown | 0 timeout run | low |

### Failure triage

| Case / assertion | Failure class | 可复现 | Root owner | 动作 | 理由 |
| --- | --- | ---: | --- | --- | --- |
| `wait_for_terminal_result#timeout_followed_by_wait` coverage claim | grader-defect / fixture-defect | 是 | Eval | fix-eval-first | 无 timeout 时断言空通过，不能证明该 branch。 |
| release metadata absence | unknown oracle authority | 是 | Eval | fix-eval-first | 结构缺口不等于 Skill failure。 |

### Eval-driven 修改决策

- **修改内容：** 本轮不修改 Skill。
- **决策：** `fix-eval-first`。
- **理由：** current 行为全部通过。缺口属于 Eval 合同和 fixture。

## 最小改进路线

### 现在——发布阻断

无已接纳的 Skill P0/P1。要把 provisional 提升为 pass，先关闭 eval-validity unknown：

1. 为 release trigger、routing 和 lifecycle case 补 admission metadata。
2. 增加真实 timeout 后再次 wait 的独立 lifecycle case。
3. 完整重跑 release batch，并重新执行 full/release review。

### 下一步——高价值质量改进

1. 增加执行到最终产物的 with/without Skill outcome 和 token baseline。
2. 对 10 分钟首次等待默认值做消融。

### 以后——启发式、评测或产品/runtime 工作

1. 当 release corpus 完成语义准入后，再决定是否把 non-release composition case 纳入固定发布证据。

## 停止决定

现在停止评审。256 次主批次模型运行、全部 12 个维度、最小控制审计、routing baseline 和 lifecycle trace 都已完成。当前没有证据支持修改 production Skill。下一轮必须先提供通过 strict admission 的 corpus 和真实 timeout trace。
