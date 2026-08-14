# codex-subagent-guide Skill 完整复评报告

## 结论

- **Skill：** `codex-subagent-guide`
- **模式：** `full`
- **方向：** `aligned`
- **复杂度：** `proportionate`
- **可缩减程度：** `minor`
- **发布结论：** `pass`
- **加权总分：** 94.6 / 100
- **原始质量带：** `excellent`
- **有效质量带：** `excellent`
- **覆盖率：** 100%
- **置信度：** `high`，指数 0.96
- **一句话结论：** 旧评审中的 release metadata 和 timeout 空通过问题均已关闭；完整 release eval 为 10/10 通过，剩余问题只是一处不影响执行的 eval README 文件归属描述。

本报告基于批次 `20260814T135949Z-repair-guide-release-final-20260814-89013c2d`。批次记录的 Git HEAD 是 `4efcc101e1b0b217ede0f17d1fa5b366879578fc`，source digest 是 `sha256:ae6a528f487fd47fc41e18bed7377beedd0626a3b8e90877724f91c4a64e36e4`，`inScopeDirty=true`。该批次一次完整运行覆盖所有 release-required profile 和 suite。

- **正式发布授权：** 已授权。用户明确要求 publish 报告。
- **README 登记授权：** 未授权。本次不运行 `review:release`，不修改 README。

## 评审合同

| 项目 | 从材料提取的结论 | 状态 |
| --- | --- | --- |
| 目标问题 | 在委派已授权后，稳定选择 role 和参数，管理 context、wait 和安全 cleanup；不授予委派权限。 | known |
| 已观察失败 | 上一轮没有 production 行为失败，但 release corpus 缺少 admission metadata，且 lifecycle timeout 分支没有真实运行；本轮均有关闭证据。 | known |
| 成功标准 | 已授权且无专用 owner；按最终交付物选 role；显式字段不丢失；默认 clean context；只认 runtime 终态；安全 cleanup。 | known |
| 目标环境或客户端 | Codex CLI 0.147.0，模型 `gpt-5.6-luna`，provider `openai-oauth`；覆盖 V1/V2 schema、四个 guide role 和 timeout profile。 | known |
| 范围外事项 | 判断是否授权委派、专用 Skill 已拥有的委派、只讨论多 Agent、插件安装和配置说明。 | known |
| 相邻 Skill | `codex-explore` 是大型只读事实探索的专用 owner；适用时由它完整管理流程。 | known |
| 发布要求 | manifest 要求五个 release profile、trigger validation/sanity、routing、normal lifecycle 和 timeout lifecycle。用户要求 full 复评和正式报告发布。 | known |

## 发布门禁

| Gate ID | 状态 | 严重性 | Finding IDs | 证据 | 原因 |
| --- | --- | --- | --- | --- | --- |
| package-validity | pass | P0 | — | strict validator、build、21/21 tests、artifact digest | 包和最终制品有效。 |
| critical-artifacts | pass | P0 | — | Skill、4 roles、renderer、manifest、2 lifecycle case 文档 | 核心材料存在。 |
| goal-alignment | pass | P0 | — | description、role/context/wait rules | 只管理已授权的通用委派。 |
| capability-validity | pass | P0 | — | V1/V2 routing、materialized roles、wait trace | 所需能力存在。 |
| safety-permissions | pass | P0 | — | authorization gate、exact context、runtime terminal | 不静默授予权限或近似上下文。 |
| architecture-ownership | pass | P1 | — | owner 审计、runtime trace | runtime 管理状态；renderer 管理配置。 |
| release-evidence | pass | P1 | — | 10/10 release target；257 次模型运行 | 当前完整 release 结果通过。 |
| eval-validity | pass | P1 | — | 全部 release case strict 0 error；真实 timeout trace | oracle 和关键 lifecycle assertion 有效。 |
| eval-change-safety | not_applicable | P1 | — | 没有 production Skill 修改 | 本轮只修复 Eval 合同和覆盖。 |

## 优点

- 严格插件校验、build、版本 author gate 和 9 个插件脚本测试文件通过；Node 测试为 21/21。
- release trigger validation 7/7、sanity 6/6。load recall/specificity 为 27/27 与 12/12；spawn recall/specificity 为 21/21 与 18/18。
- routing 18/18 case 通过。V1/V2 的 current 为 108/108；without-owner-Skill baseline 为 79/108，机械正确率提高约 26.9 个百分点。
- current routing 总时长为 1,616,024 ms，baseline 为 1,683,168 ms；current 平均约 15.0 秒，baseline 约 15.6 秒。
- normal lifecycle 使用 `timeout_ms=600000`，等待到真实终态后返回结果。
- timeout lifecycle 使用 75 秒 helper。首次 `timeout_ms=60000` 真实超时，随后再次 wait，并取得终态结果；8 个 lifecycle assertion 全部通过。
- release-counted 的 33 个 case 覆盖 11 个 scenario family、19 个 representative、13 个 boundary、1 个 regression，并记录 14 个明确 minimal counterexample。

## 必须修复的问题

无 P0/P1 finding。

## 非阻断问题

| ID | 严重性 | 证据类型 | 维度 | 位置 | 观察 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| F-GUIDE-003 | P2 | structural | maintainability | `evals/README.md:52` | README 称 `lifecycle-evals.json` 提供两条真实 timeline case，但正常 case 位于该文件，timeout case 位于 `lifecycle-timeout-evals.json`。 | 改为“两份 lifecycle case 文档各提供一条”，并分别点名文件。 |

F-GUIDE-003 不影响 runtime、manifest 或 eval 机械结果。README 后续两条命令和 manifest 的 suite 映射均正确。

## 未知项

| ID | 维度 | 描述 | 所需证据 |
| --- | --- | --- | --- |
| U-GUIDE-001 | minimum_control | 首次响应式等待精确使用十分钟的默认值没有独立消融证据。 | 比较更短、十分钟和更长首次窗口的假失败、轮询次数、完成时间和中断响应。 |
| U-GUIDE-002 | problem_value | routing baseline 证明调用正确性和时长差，但没有覆盖下游最终结果质量和完整 token 成本。 | 让代表任务执行到最终结果，比较 with/without Skill 的质量、token、时长和方差。 |

## 维度评分

| 维度 | 权重 | 分数 | 置信度 | 证据 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- | --- |
| 规范与包完整性 | 6 | 5.0 | high | validator、build、tests、5 profiles | — | — | 包和最终制品完整。 |
| 问题基础与实际价值 | 8 | 4.5 | high | current 108/108；baseline 79/108；时长差 | — | U-GUIDE-002 | 增量明确，缺下游 outcome/token。 |
| 调用策略、触发条件与 Context Pointer | 10 | 5.0 | high | release trigger 全通过 | — | — | 授权和 near-miss 稳定。 |
| 范围、边界与组合性 | 8 | 5.0 | high | authorization/specialized-owner gate；routing | — | — | 通用 owner 边界清楚。 |
| 程序与完成边界 | 10 | 5.0 | high | routing 18/18；normal 和 timeout lifecycle | — | — | 参数、context 和终态标准清楚。 |
| 最小充分控制与模型自由度 | 14 | 3.5 | medium | 最小控制审计 | — | U-GUIDE-001 | 控制紧凑，精确等待值待消融。 |
| 信息层级、资源与渐进式披露 | 10 | 5.0 | high | renderer、schema/runtime lookup | — | — | 信息放置正确。 |
| 职责归属与自然语言状态机风险 | 10 | 5.0 | high | owner 审计、agent-only monitoring | — | — | 状态由 runtime 管理。 |
| 脚本与确定性自动化 | 7 | 5.0 | high | renderer、21 tests、CLI help、negative timelines | — | — | 自动化充分。 |
| Eval 设计、Oracle 有效性与修改安全 | 9 | 5.0 | high | 10/10 release；strict corpus；216 routing runs；2 lifecycle trace | — | — | 达到发布级。 |
| 可靠性、安全与兼容性 | 4 | 5.0 | high | V1/V2、profiles、runtime terminal/timeout | — | — | 声明已验证。 |
| 剪枝、事实源与变更纪律 | 4 | 4.5 | high | 单一 renderer；紧凑 Skill；README 文件归属错误 | F-GUIDE-003 | — | 一处 eval 文档需校正。 |

## 调用与 Context Pointer 审计

| Pointer | 目标材料 | 触发 branch | 意图是否前置 | 是否重复同义 branch | 是否重复正文身份 | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| frontmatter description | 已授权、无专用 owner、需要实际执行的通用委派 | authorization；discussion-only；specialized-owner | 是 | 否 | 否 | release load 27/27 与 12/12；spawn 21/21 与 18/18 | 保持。 |
| `agents/openai.yaml` default prompt | 用户显式调用 `$codex-subagent-guide` | explicit invocation | 是 | 否 | 否 | explicit boundary 稳定 load、0 spawn | 保持。 |
| compatibility | 当前 schema 和四个 bundled role | spawn/wait/cleanup | 是 | 否 | 否 | V1/V2 routing、5 profiles | 保持为环境 lookup。 |

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
| authorization gate | 防止 Skill 自行授予权限 | project boundary、trigger | invariant | 否 | keep-invariant | 高。 |
| specialized owner 优先 | 防止双重 lifecycle owner | composition policy | invariant | 否 | keep-invariant | 高。 |
| schema 为准、显式字段保留 | 防止非法或降级调用 | routing 108/108 | invariant | 否 | keep-invariant | 高。 |
| 四个 preset | 稳定 role 选择 | current/baseline delta | default | 部分 | keep-default | 中。 |
| clean context、自包含 message | 降低隐式依赖和泄露 | routing | default | 部分 | keep-default | 中。 |
| 精确 inheritance | 防止 full-history 近似 | schema 边界 | invariant | 否 | keep-invariant | 高。 |
| 首次至少十分钟 | 降低短轮询和假失败 | normal/timeout trace | default | 未知 | needs-ablation | 未知。 |
| timeout 非失败、只认终态 | 防止提前完成 | runtime fact、timeout regression | invariant | 否 | keep-invariant | 高。 |
| agent-only monitoring | 防止旁路状态机 | architecture | invariant | 否 | keep-invariant | 高。 |
| 安全 cleanup | 防止结果或后代丢失 | lifecycle assertions | invariant | 否 | keep-invariant | 高。 |

## 信息层级图

| 内容 | 类型 | 适用 branch | 当前位置 | 是否每次需要 | 到达 pointer 或环境事实源 | 最小控制结论 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| authorization 和 owner gate | in-file-step | 所有调用 | description | 是 | 用户、AGENTS.md、specialized Skill | keep-invariant | 保持。 |
| preset/custom 和 role 表 | in-file-step | spawn | generated Spawn 参数 | 是 | renderer | keep-default/invariant | 保持。 |
| context 选择 | in-file-step | spawn | `SKILL.md` 上下文 | 是 | current schema | keep-default/invariant | 保持。 |
| wait 和 cleanup | in-file-reference | 需要结果时 | `SKILL.md` 等待与清理 | 否 | runtime status | mixed | 等待值待消融。 |
| 字段和 role 存在性 | environment-lookup | spawn | schema/materialized roles | 否 | Codex | keep-invariant | 不缓存。 |
| terminal、timeout、后代 | environment-lookup | wait/cleanup | runtime | 否 | agent tools | keep-invariant | 不用旁路推断。 |

## 完成边界审计

| 步骤或规则集 | 当前标准 | 清楚 | 可检查 | 要求充分 | 覆盖完整 | 提前完成风险 | 建议 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| authorization/owner | 已授权且无 specialized owner | 是 | 是 | 是 | 是 | 高 | 保持。 |
| role/fields | preset 按交付物；custom 字段完整可用 | 是 | 是 | 是 | 是 | 中 | 保持。 |
| context | 默认 clean；继承必要且可精确表达 | 是 | 是 | 是 | 是 | 中 | 保持。 |
| wait | 父代理需要结果；runtime 未终态则未完成；timeout 后结果仍必要则继续 wait | 是 | 是 | 是 | 是 | 高 | 保持。 |
| cleanup | 结果已保存，目标和后代都不再需要 | 是 | 是 | 是 | 是 | 高 | 保持。 |

## 架构与职责归属

- **Skill 负责的策略：** authorization 前提、specialized owner 优先、role/default、context、wait 和 cleanup 原则。
- **Schema 或客户端负责的事实：** `agent_type`、model、reasoning、fork 和 wait 字段及合法值。
- **Runtime 负责的状态：** agent 是否存在、active/terminal、timeout、通知和后代关系。
- **脚本候选：** role 表、默认模型、等待配置和 timeline assertion 已脚本化；不新增 runtime 状态脚本。
- **仅属于 role 的约束：** 子代理只执行 message 中的任务并返回结果。
- **仅属于 eval 或 issue 的问题：** 十分钟默认值消融；README 文件归属。
- **自然语言状态机风险：** `low`。Inspector 给出 moderate/high heuristic 信号，但没有本地状态表或旁路状态。

## 脚本与资源

- **已有脚本或正确省略：** renderer 生成四个 guide role 和最终 Skill；eval runner 处理 trigger、routing 和两个 lifecycle suite。
- **接口、依赖和安全质量：** build、validator、21 tests 通过；lifecycle runner 完成静态检查，`--help` 安全返回 0。
- **模型仍在重复的确定性逻辑：** 无。role 配置、原始 spawn 参数和 timeline assertion 已脚本化。
- **Reference 和 asset 可达性：** runtime Skill 无必读 reference 或 asset。Inspector 报告的 `scripts/delayed-simple.mjs` 缺失是 fixture 动态生成关系，不是 production 资源断裂。
- **重复：** source 使用 placeholder；最终 Skill 只有一份 role 表。
- **Scattering 与 co-location：** production policy 在 Skill；生成逻辑在单一 renderer；eval 与 owner 同目录。
- **不必要缓存的环境事实：** 未发现。
- **过期或孤立资源：** 未发现 production 孤立资源；README 文件归属见 F-GUIDE-003。

## Eval Case Audit

### 目标和错误代价

| Suite | Optimization policy | False-negative cost | False-positive cost | 判定 |
| --- | --- | --- | --- | --- |
| release trigger | critical | high | critical | policy 和 case metadata 完整。 |
| routing | critical | critical | critical | policy、baseline 和原始参数 oracle 完整。 |
| normal lifecycle | critical | critical | high | normal terminal path 独立。 |
| timeout lifecycle | critical | critical | high | timeout continuation regression 独立。 |
| non-release composition | critical | high | critical | strict metadata 完整；不进入 release。 |

### Eval 门禁

| Gate | 状态 | 证据 | 原因 |
| --- | --- | --- | --- |
| eval-validity | pass | 所有 case 文档 strict 0 error；真实 timeout trace | 层级、oracle、前提和断言可靠。 |
| release-evidence | pass | 10/10 covered；releaseOutcome passed | 真实运行、baseline、重复运行和 trace 完整。 |
| eval-change-safety | not_applicable | 无 production Skill 修改 | 本轮只修 Eval，不使用结果改写 Skill。 |

### Suite 构成

| 指标 | 数量或判定 |
| --- | ---: |
| Release-counted cases | 33 |
| Scenario families | 11 |
| Explicit minimal counterexamples | 14 |
| Representative cases | 19 |
| Regression cases | 1 |
| Boundary cases | 13 |
| Challenge / diagnostic release cases | 0 |
| Stale / ambiguous release cases | 0 |

### Trigger 二元决策结果

| 指标 | 当前结果 | Baseline / previous | 解释 |
| --- | ---: | ---: | --- |
| Skill-load positive recall | 27/27 = 100% | 旧版 27/27 | 保持。 |
| Skill-load false-negative rate | 0% | 0% | — |
| Skill-load negative specificity | 12/12 = 100% | 旧版 12/12 | 保持。 |
| Skill-load false-positive rate | 0% | 0% | — |
| Spawn positive recall | 21/21 = 100% | 旧版 21/21 | 保持。 |
| Spawn false-negative rate | 0% | 0% | — |
| Spawn negative specificity | 18/18 = 100% | 旧版 18/18 | 保持。 |
| Spawn false-positive rate | 0% | 0% | — |
| Mixed / uncertain release cases | 0 | 0 | 当前固定 split 全部一致。 |

### Behavior、outcome 和 cost 证据

| Scenario family | With Skill | Baseline | Quality delta | Token/time delta | 方差 | 证据强度 |
| --- | --- | --- | --- | --- | --- | --- |
| V1/V2 routing | 108/108 | 79/108 | +26.9 percentage points | current 15.0 s/run；baseline 15.6 s/run；token 只在部分 run 可用 | 每组合 3 次 | high mechanical |
| normal terminal lifecycle | 1/1 | 无 | 10 分钟参数、终态和 cleanup 顺序正确 | 27.0 s；62,536 input、520 output | 1 run | medium-high |
| timeout continuation | 1/1 | 旧版未观察 timeout | 从无覆盖到真实 timeout + re-wait + terminal | 100.2 s；token 不可用 | 1 deterministic regression | high branch evidence |

### Failure triage

| Case / assertion | Failure class | 可复现 | Root owner | 动作 | 理由 |
| --- | --- | ---: | --- | --- | --- |
| 旧 `timeout_followed_by_wait` 空数组通过 | grader-defect | 是 | Eval | 已关闭 | 新增 `require_timeout` 和 `timeout_observed`。 |
| 旧 normal fixture 未触发 timeout | fixture-defect | 是 | Eval | 已关闭 | 独立 75 秒 helper 和 60 秒 profile 真实触发。 |
| 旧 release metadata 缺失 | oracle authority gap | 是 | Eval | 已关闭 | 所有 release case strict 0 error、0 warning。 |
| README lifecycle 文件归属 | documentation-defect | 是 | Eval | P2 | 不影响 runner 或 manifest。 |

### Eval-driven 修改决策

- **修改内容：** 增加独立 timeout suite、`require_timeout` 结构断言、profile 过滤和 Case Admission metadata。
- **受影响场景族：** timeout continuation、terminal wait、routing/trigger oracle authority。
- **为什么不是 Skill defect：** production Skill 的 timeout 规则已正确；缺口属于 fixture、grader 和证据合同。
- **原始失败证据：** 旧报告 F-GUIDE-001、F-GUIDE-002。
- **Minimal pair / 相反标签风险：** normal case 允许无 timeout；timeout case 必须观察 timeout 和后续 wait。
- **Validation、sanity 和 regression 重跑：** trigger 7/7、6/6；routing 18/18；normal 1/1；timeout 1/1。
- **Quality delta：** eval-validity 从 unknown 变为 pass；release required target 从 8 增至 10，并全部通过。
- **Context / branch / maintenance delta：** production Skill 未修改；Eval 增加一个独立 profile 和 case，不把状态机写入 Skill。
- **决策：** `accept` Eval 修订；production `not_applicable`。

## 旧问题关闭和沉积检查

- **F-GUIDE-001：** closed。trigger、routing、normal lifecycle 和 timeout lifecycle 文档均 strict 0 error、0 warning。
- **F-GUIDE-002：** closed。真实 trace 有 `timed_out=[1]`、`waits=[1,2]` 和后续终态；缺少 timeout 或后续 wait 的单测会失败。
- **新增规则及其替代内容：** 只增加 Eval regression，不增加 production Skill 规则。
- **沉积候选：** 十分钟精确默认值仍为 `needs-ablation`；未因本轮 review 扩写。
- **净变化：** `neutral`。production 不变；Eval 覆盖和 oracle authority 增强。

## 最小改进路线

### 现在——发布阻断

无。

### 下一步——高价值质量改进

1. 关闭 F-GUIDE-003：校正 eval README 的两个 lifecycle 文件名。
2. 如果要证明下游产品收益，增加代表任务执行到最终产物的 with/without Skill 质量和 token 基线。

### 以后——启发式、评测或产品/runtime 工作

1. 对十分钟首次等待默认值做独立消融。
2. 只有出现新的 observed failure 时，再考虑修改 production Skill。

## 停止决定

现在停止评审。当前 10/10 release 目标、257 次模型运行、routing baseline、两个真实 lifecycle trace、严格 Case Admission 和 minimum control audit 足以支持 `pass`。没有证据支持继续增加 production 规则；下一轮应先出现新的 observed、normative 或 structural 证据。
