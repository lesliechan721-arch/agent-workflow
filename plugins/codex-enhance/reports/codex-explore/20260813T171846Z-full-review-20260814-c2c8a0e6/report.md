# codex-explore Skill 完整评审报告

## 结论

- **Skill：** `codex-explore`
- **模式：** `full`
- **方向：** `at-risk`
- **复杂度：** `proportionate`
- **可缩减程度：** `minor`
- **发布结论：** `pass-after-fixes`
- **加权总分：** 85.8 / 100
- **原始质量带：** `strong`
- **有效质量带：** `strong`
- **覆盖率：** 100%
- **置信度：** `high`，指数 0.93
- **一句话结论：** Skill 主体和端到端流程可靠，但 release eval 的关键词 grader 把正确失败关闭误判为失败；该错误已进入发布门禁，必须先修复 Eval。

本报告评审提交 `4efcc101e1b0b217ede0f17d1fa5b366879578fc`。主批次是 `20260813T171846Z-full-review-20260814-c2c8a0e6`，生产源 digest 是 `sha256:81ca86a95ab4390fed18c200e5dff9805a042fe299a0f99e34750648ee5dd143`，`inScopeDirty=false`。补充方差批次是 `20260813T193647Z-full-review-20260814-triage-475fd076`。

- **正式发布授权：** 已授权。用户要求推送报告。
- **README 登记授权：** 未授权。本次不运行 `review:release`，不修改 README。

## 评审合同

| 项目 | 从材料提取的结论 | 状态 |
| --- | --- | --- |
| 目标问题 | 把大型、陌生或边界不明材料中的事实搜索移出父会话，减少上下文污染；最终判断和写操作留在父代理。 | known |
| 已观察失败 | 一个窄 review 请求 3/3 误加载；一个大范围 PR review 仅 6/8 委派；一个正确失败关闭被关键词 grader 误判。 | known |
| 成功标准 | Gate 只允许可分离的大范围事实探索；role 和显式字段符合 schema；父代理不重复活跃范围；只整合终态且可核验的证据。 | known |
| 目标环境或客户端 | Codex CLI 0.147.0，模型 `gpt-5.6-luna`，provider `openai-oauth`；支持 V1/V2 multi-agent schema 和四个 explore role。 | known |
| 范围外事项 | 最终缺陷判定、质量评价、严重性、建议、实现、发布和其它写操作。 | known |
| 相邻 Skill | `codex-subagent-guide` 管理已授权且没有专用 owner 的通用委派；它不接管 explore 工作流。 | known |
| 发布要求 | manifest 要求四个 materialization profile、trigger validation/sanity、model-selection 和 workflow。用户要求 full 评审、完整 eval 和正式报告发布。 | known |

## 发布门禁

| Gate ID | 状态 | 严重性 | Finding IDs | 证据 | 原因 |
| --- | --- | --- | --- | --- | --- |
| package-validity | pass | P0 | — | validator、build、tests、artifact digest | 包和最终制品有效。 |
| critical-artifacts | pass | P0 | — | Skill、4 roles、renderer、manifest | 核心材料存在。 |
| goal-alignment | pass | P0 | — | `SKILL.md:11-25,49-67` | 事实探索与判断、写操作保持分离。 |
| capability-validity | pass | P0 | — | 当前 schema、materialization、workflow trace | 所需能力存在。 |
| safety-permissions | pass | P0 | — | `SKILL.md:24-25,51-55` | 权限继承、行为只读和公开查询脱敏明确。 |
| architecture-ownership | pass | P1 | — | owner 审计、runtime trace | runtime 管理状态；renderer 管理确定性配置。 |
| release-evidence | fail | P1 | F-EXP-001 | 8/8 target 已运行；release outcome `failed` | 已知 grader defect 使当前发布结果失败。 |
| eval-validity | fail | P1 | F-EXP-001 | `invalid_explicit_values` 三次 trace | release grader 拒绝合同允许的等价文案。 |
| eval-change-safety | not_applicable | P1 | — | 本轮没有修改 Skill | 无 eval-driven production change。 |

## 优点

- build、插件 validator、9 个插件脚本文件和 18 个 Node 测试通过。
- project/user、default/non-default 和 short-wait subject 均成功生成；artifact digest 匹配。
- workflow 3/3 通过。它覆盖专用 role、干净上下文、响应式等待、父范围隔离、终态、证据合同和零 workspace 变更。
- model-selection 的 11 个 case 中，10 个机械通过。人工复核确认剩余 case 的三次工具行为也全部符合 Skill 合同。
- release trigger 的加载 recall 为 39/39；Gate specificity 为 21/21。
- Skill 不用文件、Git 或 shell 状态模拟 agent 生命周期。

## 必须修复的问题

| ID | 严重性 | 证据类型 | 维度 | 位置 | 受影响场景 | 证据 | 反证检查 | 正确 owner | 最小修改 | 验证方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F-EXP-001 | P1 | observed, structural | evals | `evals/evals.json:518-553`；`run-model-selection-evals.mjs:239-249` | 用户提供不可用 model 和非法 reasoning effort；Skill 应原样尝试至多一次，失败后停止。 | 三次均使用 custom role、原样保留字段、只调用一次且不降级。首轮说“调度器拒绝”，但关键词列表没有“拒绝”，所以唯一失败断言是文案匹配；case 变成 2/3，并使 release suite 失败。 | oracle 允许一次拒绝后停止；三次工具行为相同，后两次只因文案包含列表中的词而通过。 | Eval | 删除脆弱文案断言，改用 runtime 拒绝和无重试的结构证据；或至少接受当前等价拒绝文案。不要修改 Skill。 | case 至少重跑 3 次；结构断言必须全通过。随后完整重跑 release batch。 |

## 非阻断问题

| ID | 严重性 | 证据类型 | 维度 | 位置 | 观察 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| F-EXP-002 | P2 | observed | triggering | `SKILL.md:3`；trigger reports | `workflow_quality_validation` 3/3 误加载但 0/3 spawn。`pr_defect_validation` 加载 8/8、spawn 6/8；两个 no-spawn trace 都在父会话执行大范围搜索。 | 收紧 description 的 minimal pair：一个已知短文件的 review 不加载；必须先做可分离广泛事实核验的 review 才加载并委派。 |
| F-EXP-003 | P2 | structural | evals | `evals/trigger-cases.json`；`evals/workflow-evals.json` | strict validator 对 31 个 trigger case 报 218 个错误，对 3 个 workflow case 报 22 个错误。缺少 error policy、层级、role、provenance、场景族、前提和 oracle。 | 先为 release-counted case 补 Case Admission metadata，再允许这些结果驱动发布或修改。 |

## 未知项

| ID | 维度 | 描述 | 所需证据 |
| --- | --- | --- | --- |
| U-EXP-001 | problem_value | workflow 没有 without-owner-Skill 的结果质量、token 和时间基线。 | 对同一代表任务运行 with/without Skill，比较质量、token、时间和方差。 |
| U-EXP-002 | minimum_control | 最多 4 个 agent 和每个子任务最多恢复一次没有隔离消融。 | 分别放宽两个限制，比较重复工作、完成率、成本和清理失败。 |

## 维度评分

| 维度 | 权重 | 分数 | 置信度 | 证据 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- | --- |
| 规范与包完整性 | 6 | 5.0 | high | validator、build、tests、profiles | — | — | 包完整。 |
| 问题基础与实际价值 | 8 | 4.0 | medium | workflow 3/3；父会话 broad-search trace | — | U-EXP-001 | 价值已观察，缺对照成本。 |
| 调用策略、触发条件与 Context Pointer | 10 | 3.5 | high | load 39/39；specificity 12/15；PR spawn 6/8 | F-EXP-002 | — | discovery 强，但边界有稳定误差。 |
| 范围、边界与组合性 | 8 | 5.0 | high | Gate、workflow | — | — | 父子职责清楚。 |
| 程序与完成边界 | 10 | 5.0 | high | model-selection 人工 11/11；workflow 3/3 | — | — | 剩余失败属于 Eval。 |
| 最小充分控制与模型自由度 | 14 | 3.5 | medium | 最小控制审计 | — | U-EXP-002 | 主体适当，两个数值上限待消融。 |
| 信息层级、资源与渐进式披露 | 10 | 5.0 | high | hierarchy map；renderer/runtime owner | — | — | 信息放置正确。 |
| 职责归属与自然语言状态机风险 | 10 | 5.0 | high | owner 审计、runtime trace | — | — | 状态由 runtime 管理。 |
| 脚本与确定性自动化 | 7 | 5.0 | high | renderer、18 tests、5 个 `--help` | — | — | 自动化充分。 |
| Eval 设计、Oracle 有效性与修改安全 | 9 | 2.0 | high | 8/8 targets；已知 grader defect；strict validation | F-EXP-001, F-EXP-003 | — | 当前 eval 不可作为可靠发布门禁。 |
| 可靠性、安全与兼容性 | 4 | 5.0 | high | V1/V2、profiles、workspace diff | — | — | 声明已验证。 |
| 剪枝、事实源与变更纪律 | 4 | 5.0 | high | 67 行模板、单一 renderer | — | — | production 结构紧凑。 |

## 调用与 Context Pointer 审计

| Pointer | 目标材料 | 触发 branch | 意图是否前置 | 是否重复同义 branch | 是否重复正文身份 | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| frontmatter description | 大型、陌生或边界不明材料的事实核验 | broad fact search；review/implementation 中可分离的 broad 子任务 | 是 | 否 | 否 | load recall 100%，negative specificity 80% | 收紧 narrow-review / broad-review minimal pair。 |
| `agents/openai.yaml` default prompt | 用户显式调用 `$codex-explore` | explicit invocation | 是 | 否 | 否 | 显式小任务 3/3 load、0/3 spawn | 保持。 |
| compatibility | 当前 spawn schema 和四个 role | Gate 通过后的能力检查 | 是 | 否 | 否 | 5 profiles materialized | 保持环境 lookup，不复制字段表。 |

## 最小有效控制审计

### 最小行为合同

1. 只委派可与判断和写操作分离的大范围或边界不明事实探索。
2. 最终判断、严重性、建议和写操作留在父代理。
3. spawn 前确认 role 和所有显式字段都由当前 schema 支持。
4. 显式模型字段只用 custom；其它任务按歧义选择 quick、standard 或 deep。
5. 默认使用一个干净上下文代理，并提供自包含 message。
6. 继承权限边界；公开搜索前最小化并脱敏输入。
7. runtime 未明确终态时保持 active；父代理不重复调查。
8. 只整合终态且可核验证据；安全时才 cleanup。

### 控制面

| Signal | Count / observation | Risk |
| --- | ---: | --- |
| Mandatory stages | Gate、schema/role、spawn、wait、integrate/cleanup | medium；顺序错误会越界。 |
| Hard gates | 范围价值、可分离、无判断/写操作、能力和权限可确认 | high；需要保留。 |
| Fixed intermediate artifacts | 0 | low。 |
| Prohibitions | role 降级、权限误述、敏感外发、重复调查、短轮询、过早 cleanup 等 | medium；大多有直接风险。 |
| Conditional branches | role/custom、fan-out、恢复、fallback、cleanup | medium。 |
| Fixed output fields | 父代理 0；叶子格式由 role 管理 | low。 |

### 必要性映射与简化候选

| 当前行为块 | 改变的行为 | 依据 | 当前控制类型 | 模型默认能否处理 | 处理建议 | 删除或放宽风险 |
| --- | --- | --- | --- | ---: | --- | --- |
| Gate 三项条件 | 防止把判断、小范围读取或写操作委派出去 | 目标合同、trigger trace | invariant | 否 | keep-invariant | 高。 |
| schema/role preflight | 防止非法或降级调用 | runtime schema | invariant | 否 | keep-invariant | 高。 |
| preset/custom 选择 | 稳定质量和显式字段 | model-selection | default + invariant | 部分 | keep-default | 中。 |
| clean context、自包含 message | 降低泄露和隐式依赖 | workflow | default | 部分 | keep-default | 中。 |
| 默认一个 agent | 降低重复调查 | 成本原则 | default | 是 | keep-default | 低到中。 |
| 最多四个 agent | 限制 fan-out | 无隔离证据 | invariant | 未知 | needs-ablation | 未知。 |
| 权限继承和脱敏 | 防止错误安全声明和外泄 | 安全边界 | invariant | 否 | keep-invariant | 高。 |
| active/terminal、禁止重复接管 | 防止并发冲突 | runtime trace | invariant | 否 | keep-invariant | 高。 |
| 长 wait、禁止主动探测 | 防止假失败和轮询 | workflow | default | 部分 | keep-default | 中。 |
| 恢复最多一次 | 限制恢复循环 | 无隔离证据 | invariant | 未知 | needs-ablation | 未知。 |

## 信息层级图

| 内容 | 类型 | 适用 branch | 当前位置 | 是否每次需要 | 到达 pointer 或环境事实源 | 最小控制结论 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| Gate 与停止条件 | in-file-step | 所有隐式调用 | `SKILL.md:13-27` | 是 | description | keep-invariant | 保持。 |
| role 与 override | in-file-step | Gate 通过后 | `SKILL.md:29-47` | 是 | spawn schema | keep-default/invariant | 保持。 |
| 权限、隐私、active 不变量 | in-file-reference | 对应 branch | `SKILL.md:49-55` | 否 | parent profile/runtime | keep-invariant | 保持。 |
| wait、恢复、integrate、cleanup | in-file-reference | spawn 成功后 | `SKILL.md:57-67` | 否 | runtime status | mixed | 数值限制待消融。 |
| role key、字段、状态 | environment-lookup | spawn/wait | tool schema 和 materialized roles | 否 | Codex runtime | keep-invariant | 不缓存。 |
| 叶子证据格式 | environment-lookup | explore role | generated role | 否 | role artifact | keep-invariant | 不复制到父 Skill。 |

## 完成边界审计

| 步骤或规则集 | 当前标准 | 清楚 | 可检查 | 要求充分 | 覆盖完整 | 提前完成风险 | 建议 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| Gate | 三项条件全部满足，且无停止条件 | 是 | 是 | 是 | 是 | 中 | 保持。 |
| preflight | role 和全部显式字段可表达 | 是 | 是 | 是 | 是 | 高 | 保持。 |
| spawn | role、clean context、message 正确 | 是 | 是 | 是 | 是 | 中 | 保持。 |
| wait/active | runtime 未终态则继续保持未完成 | 是 | 是 | 是 | 是 | 高 | 保持。 |
| evidence acceptance | 回答问题；claim 绑定来源；区分 direct/inference/conflict/gap | 是 | 是 | 是 | 是 | 中 | 保持。 |
| cleanup | 结果已保留，目标和必要后代均不再需要 | 是 | 是 | 是 | 是 | 中 | 保持。 |

## 架构与职责归属

- **Skill 负责的策略：** Gate、父子边界、role 默认、显式字段保留、clean context、等待和整合原则。
- **Schema 或客户端负责的事实：** 可用字段、合法值、role key、context 参数和 wait 上限。
- **Runtime 负责的状态：** active/terminal、timeout、通知、后代关系和停止结果。
- **脚本候选：** role/config 渲染和 eval 解析已脚本化；不新增 runtime 状态脚本。
- **仅属于 role 的约束：** 叶子行为只读、证据定位和结构化结果。
- **仅属于 eval 或 issue 的问题：** grader 关键词、case metadata 和方差样本。
- **自然语言状态机风险：** `medium`。静态 inspector 给出 high heuristic 信号，但关键状态仍由 runtime 提供。

## 脚本与资源

- **已有脚本或正确省略：** renderer 生成 Skill、roles 和等待配置；eval runner 处理 trigger、routing、workflow 和 liveness。
- **接口、依赖和安全质量：** build、validator、18 tests 通过；五个 agent-facing eval 入口的 `--help` 均安全返回 0。
- **模型仍在重复的确定性逻辑：** 无。role/config 和机械断言已脚本化。
- **Reference 和 asset 可达性：** runtime Skill 无必读 reference 或 asset。
- **重复：** 父 Skill 不复制叶子 role 的完整证据格式。
- **Scattering 与 co-location：** production policy 在 Skill；role/config 在单一 renderer；eval 与 owner Skill 同目录。
- **不必要缓存的环境事实：** 未发现。
- **过期或孤立资源：** 未发现 production 孤立资源。Eval metadata 缺口见 F-EXP-003。

## Eval Case Audit

### 目标和错误代价

| Suite | Optimization policy | False-negative cost | False-positive cost | 判定 |
| --- | --- | --- | --- | --- |
| model-selection | critical | high | critical | 已记录。 |
| trigger | unknown | unknown | unknown | release corpus 没有 policy metadata。 |
| workflow | unknown | unknown | unknown | release corpus 没有 policy metadata。 |

### Eval 门禁

| Gate | 状态 | 证据 | 原因 |
| --- | --- | --- | --- |
| eval-validity | fail | F-EXP-001；strict validator | 已知 grader defect 正在驱动 release 结果。 |
| release-evidence | fail | 8/8 covered；release outcome failed | 结果完整，但当前机械结论无效且失败。 |
| eval-change-safety | not_applicable | 无 production change | 本轮不接受 eval-driven Skill 修改。 |

### Suite 构成

| 指标 | 数量或判定 |
| --- | ---: |
| release cases | 32：trigger 18、model-selection 11、workflow 3 |
| recorded scenario families | 5，仅 model-selection 记录 |
| recorded representative cases | 6 |
| recorded regression cases | 1 |
| recorded boundary cases | 4 |
| unclassified release cases | 21 |
| stale / ambiguous cases | 0 已确认 stale；21 个 case 的 admission 状态未记录 |

### Trigger 二元决策结果

| 指标 | 当前结果 | Baseline / previous | 解释 |
| --- | ---: | ---: | --- |
| Skill-load positive recall | 39/39 = 100% | 无 | 正例都加载。 |
| Skill-load false-negative rate | 0% | 无 | — |
| Skill-load negative specificity | 12/15 = 80% | 无 | narrow workflow review 3/3 false load。 |
| Skill-load false-positive rate | 20% | 无 | 仅增加 context；没有 spawn。 |
| Gate positive recall | 32/33 = 97.0% | 补充后 PR branch 合并为 6/8 | 主 release 是 14/15；补充 evidence 显示稳定方差。 |
| Gate false-negative rate | 3.0% | — | 主 release 1 次；补充批次另 1 次。 |
| Gate negative specificity | 21/21 = 100% | 无 | 没有错误 spawn。 |
| Gate false-positive rate | 0% | 无 | — |

### Behavior、outcome 和 cost 证据

| Scenario family | With Skill | Baseline | Quality delta | Token/time delta | 方差 | 证据强度 |
| --- | --- | --- | ---: | ---: | --- | --- |
| role/override routing | 人工行为 11/11；机械 10/11 | 无 | unknown | 无统一对照 | invalid case 3 次行为一致 | medium |
| end-to-end workflow | 3/3 | 无 | unknown | 无统一对照 | 1 run/case | medium |
| PR broad-search Gate | 6/8 spawn | 无 | parent context isolation 2/8 失败 | 无统一 token 对照 | mixed | medium |

### Failure triage

| Case / assertion | Failure class | 可复现 | Root owner | 动作 | 理由 |
| --- | --- | ---: | --- | --- | --- |
| `invalid_explicit_values#final_message_includes_any` | grader-defect | 是，1/3 | Eval | fix-eval-first | 工具行为三次相同且正确；只差等价用词。 |
| `workflow_quality_validation#load` | skill-defect | 是，3/3 | Skill | P2 minimal-pair clarification | narrow known-source review 不需要 Skill。 |
| `pr_defect_validation#spawn` | skill-defect | 是，2/8 | Skill | collect-more-data；P2 | broad search 在父会话发生，但 6/8 正常委派。 |

### Eval-driven 修改决策

- **修改内容：** 本轮不修改 Skill。
- **决策：** `fix-eval-first`。
- **理由：** P1 根因在 grader。Trigger P2 需要 minimal pair、固定 validation/sanity 和净回归证据后才可修改 description。

## 最小改进路线

### 现在——发布阻断

1. 修复 `invalid_explicit_values` 的文案 grader，不修改 Skill。
2. 完整重跑 release batch；`model-selection` 和 release outcome 必须通过。

### 下一步——高价值质量改进

1. 为 trigger 和 workflow release case 补 admission metadata，并通过 strict validator。
2. 用 narrow review / broad evidence review minimal pair 收紧 description；固定重跑 validation 和 sanity。

### 以后——启发式、评测或产品/runtime 工作

1. 对 fan-out 上限和恢复上限做独立消融。
2. 增加 with/without Skill 的 workflow 质量和成本基线。

## 停止决定

现在停止评审。P1 根因已由三次原始工具 trace 精确定位；95 次模型运行、全部 12 个维度、最小控制审计和两个 trigger 边界都已完成。下一轮必须先出现修复后的完整 release eval，继续读取当前材料不会改变结论。
