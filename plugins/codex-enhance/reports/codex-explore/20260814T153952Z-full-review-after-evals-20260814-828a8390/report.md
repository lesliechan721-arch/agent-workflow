# codex-explore Skill 完整复评报告

## 结论

- **Skill：** `codex-explore`
- **模式：** `full`
- **方向：** `aligned`
- **复杂度：** `proportionate`
- **可缩减程度：** `minor`
- **发布结论：** `pass`
- **加权总分：** 93.3 / 100
- **原始质量带：** `excellent`
- **有效质量带：** `excellent`
- **覆盖率：** 100%
- **置信度：** `high`，指数 0.93
- **一句话结论：** 旧评审中的 release grader、触发边界和 release case metadata 问题均已关闭；完整 release eval 为 8/8 通过，剩余问题只影响非 release 的 liveness 诊断语料。

本报告基于批次 `20260814T130906Z-repair-trigger-release-final-v2-20260814-d7eb976d`。批次记录的 Git HEAD 是 `4efcc101e1b0b217ede0f17d1fa5b366879578fc`，source digest 是 `sha256:7d01a3b20060fd8aba9e54e9e72243b0d90a134aa82a72dde54145aacc99720b`，`inScopeDirty=true`。Explore 的 project-default 最终 `SKILL.md` digest 为 `sha256:8cd9720ba97f6a1e2a26ab88937a6c1b2be808776cce65315a4555ab313eaa77`；该 digest 与更晚的 Guide 完整批次中的 Explore artifact 一致，因此后续 Guide eval 改动没有使本批次的 Explore 生产制品过期。

正式发布使用当前源码创建 review-only 批次。原因是完整 Explore eval 完成后，插件内 Guide 的 eval 资产继续修改，使插件级 source digest 改变。发布工具正确拒绝把旧 digest 封存为当前源码报告。本报告不改写旧批次；所有模型行为结论仍明确引用上述完整 Explore eval，当前 review-only 批次只提供当前源码一致的正式报告载体。

- **正式发布授权：** 已授权。用户明确要求 publish 报告。
- **README 登记授权：** 未授权。本次不运行 `review:release`，不修改 README。

## 评审合同

| 项目 | 从材料提取的结论 | 状态 |
| --- | --- | --- |
| 目标问题 | 把大型、陌生或边界不明材料中的事实搜索移出父会话，减少上下文污染；最终判断和写操作留在主代理。 | known |
| 已观察失败 | 上一轮发现失败关闭关键词 grader、窄 review 误加载、broad review 委派方差和 release metadata 缺口；本轮均有关闭证据。 | known |
| 成功标准 | Gate 只允许可分离的大范围事实探索；role 和显式字段符合 schema；父代理不重复活跃范围；只整合终态且可核验的证据。 | known |
| 目标环境或客户端 | Codex CLI 0.147.0，模型 `gpt-5.6-luna`，provider `openai-oauth`；覆盖 V1/V2 multi-agent schema 和四个 Explore role。 | known |
| 范围外事项 | 最终缺陷判定、质量评价、严重性、建议、实现、发布和其它写操作。 | known |
| 相邻 Skill | `codex-subagent-guide` 管理已授权且没有专用 owner 的通用委派；它不接管 Explore 工作流。 | known |
| 发布要求 | manifest 要求四个 release materialization profile、trigger validation/sanity、model-selection 和 workflow。用户要求 full 复评和正式报告发布。 | known |

## 发布门禁

| Gate ID | 状态 | 严重性 | Finding IDs | 证据 | 原因 |
| --- | --- | --- | --- | --- | --- |
| package-validity | pass | P0 | — | strict validator、build、21/21 tests、artifact digest | 包和最终制品有效。 |
| critical-artifacts | pass | P0 | — | Skill、4 roles、renderer、manifest、release case 文档 | 核心材料存在。 |
| goal-alignment | pass | P0 | — | `SKILL.md` Gate、role 和父子边界 | 事实探索与判断、写操作保持分离。 |
| capability-validity | pass | P0 | — | V1/V2 trace、materialized roles、schema preflight | 所需能力存在。 |
| safety-permissions | pass | P0 | — | 权限继承、行为只读、公开查询脱敏、workspace diff | 不静默升级权限或外传私有材料。 |
| architecture-ownership | pass | P1 | — | owner 审计、runtime trace | runtime 管理状态；renderer 管理确定性配置。 |
| release-evidence | pass | P1 | — | 8/8 release target；87 次 release 模型运行 | 当前完整 release 结果通过。 |
| eval-validity | pass | P1 | — | release case strict 0 error；结构化失败关闭 | release-counted oracle 和 grader 有效；liveness 明确不参与 release。 |
| eval-change-safety | pass | P1 | — | 8+8 minimal pair、固定 validation/sanity、关键 regression | description 修订没有伤害相邻边界。 |

## 优点

- 严格插件校验、build、版本 author gate 和 9 个插件脚本测试文件通过；Node 测试为 21/21。
- release trigger 的 Skill load recall 为 39/39，specificity 为 12/12；Gate spawn recall 为 33/33，specificity 为 18/18。
- `invalid_explicit_values` 三次都保留 custom role 和两个显式字段，只调用一次，真实 runtime 拒绝后停止；没有降级或重试。
- workflow 3/3 通过。V1、V2 和对抗只读 case 均取得终态、来源定位、预期事实、父范围隔离和零 workspace 变更。
- release-counted 的 31 个 case 覆盖 13 个 scenario family、17 个 representative、13 个 boundary、1 个 regression，并记录 14 个明确 minimal counterexample。
- production Skill 不用文件、Git、shell sleep 或轮询模拟 agent 生命周期。

## 必须修复的问题

无 P0/P1 finding。

## 非阻断问题

| ID | 严重性 | 证据类型 | 维度 | 位置 | 观察 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| F-EXP-004 | P2 | structural | evals | `evals/liveness-evals.json:1-79`；`evals/README.md:62-70` | 非 release 的三个 liveness case 没有错误代价政策和 Case Admission metadata，但 README 仍把其历史 A/B 结果作为当前无 probe 设计的消融依据。严格结构审计报告 22 个缺失项。 | 补 policy、case role、provenance、scenario family、preconditions 和 oracle；或明确保持 diagnostic-only，并收窄 README 的消融结论。 |

F-EXP-004 不影响本轮 release verdict。`manifest.json` 明确设置 `liveness.requiredForRelease=false`，完整 release 批次没有使用它；release workflow 仍独立验证正常路径没有主动 probe。

## 未知项

| ID | 维度 | 描述 | 所需证据 |
| --- | --- | --- | --- |
| U-EXP-001 | problem_value | workflow 没有可比的 without-owner-Skill 最终质量、token 和时间基线。 | 对相同代表任务运行 with/without Skill，比较结果质量、token、时长和方差。 |
| U-EXP-002 | minimum_control | 最多四个 agent 和每个子任务最多恢复一次没有独立消融证据。 | 分别改变两个限制，比较重复工作、完成率、成本和清理失败。 |

## 维度评分

| 维度 | 权重 | 分数 | 置信度 | 证据 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- | --- |
| 规范与包完整性 | 6 | 5.0 | high | validator、build、tests、profiles | — | — | 包和最终制品完整。 |
| 问题基础与实际价值 | 8 | 4.0 | medium | workflow 3/3；旧父会话 broad-search trace；8+8 pair | — | U-EXP-001 | 价值明确，缺可比下游成本。 |
| 调用策略、触发条件与 Context Pointer | 10 | 5.0 | high | load 39/39 与 12/12；spawn 33/33 与 18/18 | — | — | broad/narrow 边界稳定。 |
| 范围、边界与组合性 | 8 | 5.0 | high | Gate、roles、workflow | — | — | 父子职责清楚。 |
| 程序与完成边界 | 10 | 5.0 | high | model-selection 33/33；workflow 3/3 | — | — | 失败关闭和终态标准可检查。 |
| 最小充分控制与模型自由度 | 14 | 3.5 | medium | 最小控制审计 | — | U-EXP-002 | 主体适当，两个数值上限待消融。 |
| 信息层级、资源与渐进式披露 | 10 | 5.0 | high | hierarchy map；renderer/runtime owner | — | — | 信息放置正确。 |
| 职责归属与自然语言状态机风险 | 10 | 5.0 | high | owner 审计、runtime trace | — | — | 真实状态由 runtime 管理。 |
| 脚本与确定性自动化 | 7 | 5.0 | high | renderer、21 tests、CLI help、grader tests | — | — | 自动化充分。 |
| Eval 设计、Oracle 有效性与修改安全 | 9 | 4.5 | high | 8/8 release；strict release corpus；trace；历史 liveness 缺口 | F-EXP-004 | — | release 级证据可靠，诊断消融待补。 |
| 可靠性、安全与兼容性 | 4 | 5.0 | high | V1/V2、profiles、失败关闭、workspace diff | — | — | 声明已验证。 |
| 剪枝、事实源与变更纪律 | 4 | 5.0 | high | 单一 renderer；description 替换旧边界；release intent | — | — | production 结构紧凑。 |

## 调用与 Context Pointer 审计

| Pointer | 目标材料 | 触发 branch | 意图是否前置 | 是否重复同义 branch | 是否重复正文身份 | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| frontmatter description | 大型、陌生或边界不明材料中的可分离事实探索 | broad fact search；review/implementation 中的 broad 子任务；known-source near miss | 是 | 否 | 否 | release load 39/39 与 12/12；8+8 pair | 保持。 |
| `agents/openai.yaml` default prompt | 用户显式调用 `$codex-explore` | explicit invocation | 是 | 否 | 否 | 显式小任务稳定 load、0 spawn | 保持。 |
| compatibility | 当前 spawn schema 和四个 role | Gate 通过后的能力检查 | 是 | 否 | 否 | project/user、default/non-default materialized | 保持为环境 lookup。 |

## 最小有效控制审计

### 最小行为合同

1. 只委派可与判断和写操作分离的大范围或边界不明事实探索。
2. 最终判断、严重性、建议和写操作留在主代理。
3. spawn 前确认 role 和全部显式字段由当前 schema 支持。
4. 显式模型字段只用 custom；其它任务按歧义选择 quick、standard 或 deep。
5. 默认使用一个干净上下文代理，并提供自包含 message。
6. 继承权限边界；公开搜索前最小化并脱敏输入。
7. runtime 未明确终态时保持 active；主代理不重复调查。
8. 只整合终态且可核验证据；结果保留后才 cleanup。

### 控制面

| Signal | Count / observation | Risk |
| --- | ---: | --- |
| Mandatory stages | Gate、schema/role、spawn、wait、integrate/cleanup | medium；顺序错误会越界。 |
| Hard gates | 范围价值、可分离、无判断/写操作、能力和权限可确认 | high；必须保留。 |
| Fixed intermediate artifacts | 0 | low。 |
| Prohibitions | role 降级、权限误述、敏感外发、重复调查、短轮询、过早 cleanup | medium；大多有直接风险。 |
| Conditional branches | role/custom、fan-out、恢复、fallback、cleanup | medium。 |
| Fixed output fields | 主代理 0；叶子格式由 role 管理 | low。 |

### 必要性映射与简化候选

| 当前行为块 | 改变的行为 | 依据 | 当前控制类型 | 模型默认能否处理 | 处理建议 | 删除或放宽风险 |
| --- | --- | --- | --- | ---: | --- | --- |
| Gate 三项条件 | 防止把判断、小范围读取或写操作委派出去 | 目标合同、trigger trace | invariant | 否 | keep-invariant | 高。 |
| schema/role preflight | 防止非法或降级调用 | runtime schema、regression trace | invariant | 否 | keep-invariant | 高。 |
| preset/custom 选择 | 稳定质量和显式字段 | model-selection 33/33 | default + invariant | 部分 | keep-default | 中。 |
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
| Gate 与停止条件 | in-file-step | 所有隐式调用 | `SKILL.md` Gate | 是 | description | keep-invariant | 保持。 |
| role 与 override | in-file-step | Gate 通过后 | `SKILL.md` 委派 | 是 | spawn schema | keep-default/invariant | 保持。 |
| 权限、隐私、active 不变量 | in-file-reference | 对应 branch | `SKILL.md` 不变量 | 否 | parent profile/runtime | keep-invariant | 保持。 |
| wait、恢复、integrate、cleanup | in-file-reference | spawn 成功后 | `SKILL.md` 等待与整合 | 否 | runtime status | mixed | 数值限制待消融。 |
| role key、字段、状态 | environment-lookup | spawn/wait | tool schema 和 materialized roles | 否 | Codex runtime | keep-invariant | 不缓存。 |
| 叶子证据格式 | environment-lookup | Explore role | generated role | 否 | role artifact | keep-invariant | 不复制到父 Skill。 |

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
- **仅属于 eval 或 issue 的问题：** liveness admission metadata；fan-out 和恢复上限消融。
- **自然语言状态机风险：** `medium`。Inspector 给出 high heuristic 信号，但关键状态仍由 runtime 提供。

## 脚本与资源

- **已有脚本或正确省略：** renderer 生成 Skill、roles 和等待配置；eval runner 处理 trigger、routing、workflow 和 liveness。
- **接口、依赖和安全质量：** build、validator、21 tests 通过；修改后的 model-selection 入口完成静态检查，`--help` 安全返回 0。
- **模型仍在重复的确定性逻辑：** 无。role/config 和关键机械断言已脚本化。
- **Reference 和 asset 可达性：** runtime Skill 无必读 reference 或 asset。
- **重复：** 父 Skill 不复制叶子 role 的完整证据格式。
- **Scattering 与 co-location：** production policy 在 Skill；role/config 在单一 renderer；eval 与 owner Skill 同目录。
- **不必要缓存的环境事实：** 未发现。
- **过期或孤立资源：** 无 production 孤立资源；liveness 语料准入缺口见 F-EXP-004。

## Eval Case Audit

### 目标和错误代价

| Suite | Optimization policy | False-negative cost | False-positive cost | 判定 |
| --- | --- | --- | --- | --- |
| release trigger | critical | high | critical | policy 和 case metadata 完整。 |
| model-selection | critical | high | critical | policy 和结构断言完整。 |
| workflow | critical | high | critical | policy 和 outcome oracle 完整。 |
| non-release liveness | 未记录 | 未记录 | 未记录 | 只可作为 diagnostic；见 F-EXP-004。 |

### Eval 门禁

| Gate | 状态 | 证据 | 原因 |
| --- | --- | --- | --- |
| eval-validity | pass | release case strict 0 error；31 个 release case | 关键层级、oracle、前提和断言可靠。 |
| release-evidence | pass | 8/8 covered；releaseOutcome passed | 真实运行、trace、重复运行和当前制品 digest 完整。 |
| eval-change-safety | pass | 8+8 pair；validation/sanity；regression；workflow | production description 修改通过相邻边界回归。 |

### Suite 构成

| 指标 | 数量或判定 |
| --- | ---: |
| Release-counted cases | 31 |
| Scenario families | 13 |
| Explicit minimal counterexamples | 14 |
| Representative cases | 17 |
| Regression cases | 1 |
| Boundary cases | 13 |
| Challenge / diagnostic release cases | 0 |
| Stale / ambiguous release cases | 0；旧歧义 case 已移除或替换 |

### Trigger 与 Gate 二元决策结果

| 指标 | 当前结果 | Baseline / previous | 解释 |
| --- | ---: | ---: | --- |
| Skill-load positive recall | 39/39 = 100% | 旧版 39/39 | 保持 recall。 |
| Skill-load false-negative rate | 0% | 0% | — |
| Skill-load negative specificity | 12/12 = 100% | 旧版 12/15 = 80% | 已关闭窄 review 误加载。 |
| Skill-load false-positive rate | 0% | 20% | 改善。 |
| Gate spawn positive recall | 33/33 = 100% | 旧版主批次 14/15；补充 broad branch 6/8 | 已关闭委派方差。 |
| Gate spawn false-negative rate | 0% | 非零 | 改善。 |
| Gate spawn negative specificity | 18/18 = 100% | 21/21 | 当前 release 负例全部正确。 |
| Gate spawn false-positive rate | 0% | 0% | 保持。 |
| Mixed / uncertain release cases | 0 | 旧版存在 | 当前固定 split 无混合结果。 |

### Behavior、outcome 和 cost 证据

| Scenario family | With Skill | Baseline / previous | Quality delta | Token/time | 方差 | 证据强度 |
| --- | --- | --- | --- | --- | --- | --- |
| role/override routing | 11/11 case，33/33 repetition | 旧 grader 对一个 case 误判 | grader defect 关闭；行为全通过 | 部分提前停止，token 不完整 | 每 case 3 次 | high mechanical |
| end-to-end workflow | 3/3 | 无 without-Skill baseline | outcome、来源、隔离、只读全部通过 | 约 60–82 秒；token 可用 | 每 case 1 次 | medium-high |
| trigger boundary ablation | broad 8/8；narrow 0/8 load/spawn | 旧窄 review 3/3 误加载；broad 6/8 spawn | 双方向改善 | 仅 trigger cost | 8 次/方向 | high |

### Failure triage

| Case / assertion | Failure class | 可复现 | Root owner | 动作 | 理由 |
| --- | --- | ---: | --- | --- | --- |
| 旧 `invalid_explicit_values` 文案断言 | grader-defect | 是 | Eval | 已关闭 | 改为 runtime output / exact preflight 结构证据；3/3 通过。 |
| 旧 `workflow_quality_validation` | oracle-defect / stale-case | 是 | Eval | 已替换 | 单个已知短文件不应自动触发。 |
| 旧 `pr_defect_validation` | oracle-defect | 混合 | Eval | 已移除 | 三行 diff 不能稳定证明 broad 或 narrow。 |
| `liveness-evals.json` admission | unknown | 结构稳定 | Eval | diagnostic-only | 不进入当前 release；需先补 metadata。 |

### Eval-driven 修改决策

- **修改内容：** 收紧 description 的 known-source/broad-source 边界；把显式参数失败关闭 grader 改为结构证据；补 release Case Admission metadata。
- **受影响场景族：** review-evidence separation、known-source direct read、explicit override failure-close。
- **为什么是 Skill defect：** 只有 description 边界问题属于 Skill；关键词误判和歧义 case 属于 Eval，未错误修改 Skill。
- **原始失败证据：** 旧报告 F-EXP-001、F-EXP-002、F-EXP-003 的 trace 和 strict audit。
- **Minimal pair / 相反标签风险：** broad `composite_review_exploration` 8/8；narrow `casual_two_known_files` 0/8 load/spawn。
- **Validation、sanity 和 regression 重跑：** 7/7、10/10、11/11 model-selection、3/3 workflow。
- **Quality delta：** trigger specificity 与 Gate recall 均提升到 100%；releaseOutcome 从 failed 变为 passed。
- **Context / branch / maintenance delta：** description 替换原边界；没有新增 lifecycle stage 或 artifact。
- **决策：** `accept`。

## 旧问题关闭和沉积检查

- **F-EXP-001：** closed。grader 使用结构化 runtime rejection / preflight evidence；原 regression 3/3 通过。
- **F-EXP-002：** closed。description minimal pair 8/8 双方向通过，固定 validation/sanity 全通过。
- **F-EXP-003：** closed。trigger、model-selection 和 workflow release 文档 strict audit 均为 0 error、0 warning。
- **新增规则及其替代内容：** description 是替换，不是叠加；无 production 状态机分支增加。
- **沉积候选：** fan-out 上限和恢复上限仍为 `needs-ablation`；未因本轮 review 扩写。
- **净变化：** `neutral`。production 只改一条 pointer，复杂度未增长；Eval 证据显著增强。

## 最小改进路线

### 现在——发布阻断

无。

### 下一步——高价值质量改进

1. 关闭 F-EXP-004：为 liveness diagnostic 补 Case Admission metadata，或收窄其设计结论。
2. 如果要证明产品收益，而不仅是合同正确性，增加 workflow with/without Skill 的最终质量与成本基线。

### 以后——启发式、评测或产品/runtime 工作

1. 对最多四个 agent 和一次恢复上限分别做消融。
2. 只有出现新的 observed failure 时，再考虑修改 production Skill。

## 停止决定

现在停止评审。当前完整 release eval、结构校验、关键 trace、minimum control audit 和旧问题关闭证据足以支持 `pass`。没有证据支持继续增加 production 规则；下一轮应先出现新的 observed、normative 或 structural 证据。
