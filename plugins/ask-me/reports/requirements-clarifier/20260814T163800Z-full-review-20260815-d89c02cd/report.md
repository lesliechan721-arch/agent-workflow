# requirements-clarifier 评审

## 结论

- **设计结论：** needs-fixes
- **发布就绪度：** blocked
- **复杂度：** minimal
- **证据：** coverage `100%`；confidence `high`（0.99）

**判断：**

Skill 正文用一个短流程解决实施前关键歧义。三个 release behavior current trace 均完成预期行为，并优于 without-owner baseline。当前阻断不支持修改生产 `SKILL.md`：一个 release-counted routing case 的 prompt 和 fixture 没有唯一表达交付物范围，却把 no-load 作为高置信 hard oracle。完整 Codex 批次覆盖 7/7 required targets，但 `releaseOutcome=failed`。

**下一步：**

执行 `A-01`。

## 必须处理

### RC-F-001 `existing_convention` 使用不唯一的 hard oracle — P1

**为什么重要：**

该 case 是 router/sanity 发布门禁。十次 Codex 运行中，五次把现有策略对象视为完整惯例，五次把“同样的导出”理解为仍缺可调用导出流程。case 仍强制要求不加载 Skill，因此 required target 失败并阻断发布。

**证据：**

- `requirements-clarifier-routing-cases.json#existing_convention`；
- `plugins/ask-me/scripts/trigger-fixture.mjs#IMPLEMENTATION_REPO_FILES`；
- batch `20260814T163800Z-full-review-20260815-d89c02cd` 的 `router-sanity-project-default.json`；
- 完整 admission 见 Appendix D 的 `RC-F-001`。

**建议：**

先裁决 case 的测试对象。若只测试“复制现有策略对象”，就在 prompt 和 fixture 中明确交付物及验收边界。若允许完整导出流程解释，就修正 oracle 或把 case 改为 diagnostic。不要从这个 case 单独修改生产 Skill。

**完成标准：**

case 重新通过 strict validator；相反标签 minimal pair 通过；新的无过滤 required batch 覆盖全部 target，并且 `releaseOutcome` 不为 failed。

## 高价值改进

没有独立于 `RC-F-001` 的已证实 P2 项。`s04_complete_account_spec` 的 1/3 误载保留为 `RC-U-001`，先补证据，不加新规则。

## 已经可靠的部分

- source、Codex project/user materialization 和作者合同有效。共享 `plugin:test` 在 Codex project scope 通过 7/7。
- trigger/validation 10/10 case 通过；router/validation 6/6 case 通过。核心正例 recall 为 100%。
- 三个 release behavior current trace 都先查事实、只问必要问题、消费回复、完成交接，且 workspace 无改动。

## 决策关键的证据缺口

| ID | 缺少的证据 | 当前影响 | 获得方式 |
| --- | --- | --- | --- |
| RC-U-001 | 完整规范 near-miss 的稳定误载率和因果 | `s04_complete_account_spec` 1/3 不能单独归因为 Skill defect | 固定 minimal pair，增加 paired runs，并逐项读 load trace |
| RC-U-002 | Claude 真实模型行为 | 兼容性行为结论只覆盖 Codex | 使用受支持 runner 运行等价 Claude eval，或限制声明范围 |

## 发布限制

| Gate | 状态 | 对发布的影响 | Action ID |
| --- | --- | --- | --- |
| release-evidence | fail | 完整批次 7/7 covered，但两个 required sanity target 失败 | A-01 |
| eval-validity | fail | `existing_convention` 当前不能安全驱动发布或 Skill 修改 | A-01 |

## 质量概览

| 领域 | 状态 | 说明 |
| --- | --- | --- |
| 触发与范围 | adequate | validation 稳定；一个 mixed strict negative 和一个不唯一 router oracle 需要处理 |
| 指令、控制与架构 | strong | 三个 current behavior trace 通过；控制短且职责正确 |
| 资源、脚本与披露 | strong | agent-facing script 正确省略；fixture 和 runtime package 边界清楚 |
| Eval 与发布证据 | weak | case 结构完整，但一个 hard oracle 无效，当前 releaseOutcome failed |

## 行动路线

### 现在

1. **`A-01`：** 修正或重新裁决 `RC-F-001`，然后运行新的完整无过滤 required batch；同时保留 `RC-U-001` 的单独归因记录。

### 下一步

1. **`A-02`：** 在不改正文前提下，为 `RC-U-001` 增加固定 minimal-pair 重复证据。

### 暂不处理

1. **`A-03`：** 等项目有 Claude 模型 runner 时关闭 `RC-U-002`；当前报告只声明 Codex 行为。

## 停止与重新打开条件

**现在停止，因为：**

完整 required batch、失败 trace、三个 qualitative current/baseline trace 和全部 case admission 已复核。证据已足以把主要阻断归给 eval oracle，而不是继续扩写 Skill。

**仅在出现以下情况时重新打开：**

- `RC-F-001` 的 case 或 oracle 完成裁决；
- 新的完整 required batch 可用；
- `RC-U-001` 形成稳定的 paired-run 结果；
- 新的 observed failure、normative requirement 或 structural contradiction 出现。

# requirements-clarifier 评审技术附录

## Appendix A — 评审范围与合同

| 项目 | 从材料提取的结论 | 状态 | Evidence |
| --- | --- | --- | --- |
| 目标问题 | 在具体实施前，用最少问题补齐会改变结果、权限、范围或验收的关键歧义 | known | SKILL.md:6-33 |
| 已观察失败 | required trigger sanity 1 个 case 失败；required router sanity 1 个 case 失败 | known | batch summary、两份 sanity report |
| 成功标准 | 先查事实；不确定项分为问、默认、验证；只问必要问题；停止并交接 | known | SKILL.md:12-33、behavior oracle |
| 目标环境或客户端 | Codex project model；Codex project/user materialization；插件声明 Codex/Claude | known | manifest、plugin.json、batch environment |
| 范围外事项 | 纯只读分析、完整规范、明确惯例、内部可逆选择、用户授权默认、协作决策访谈 | known | description、trigger/routing corpus |
| 相邻 Skill | decision-grill | known | 两个 description、router suite |
| 发布要求 | full 报告正式发布并封存；不登记 README | known | 用户授权、skill-review plugin reference |

正式发布授权：已授权。README 登记授权：未授权。本轮禁止 `review:release`，也不修改 README、SKILL 或 plugin source。

## Appendix B — 完整发布门禁

| Gate ID | 状态 | 严重性 | Finding / Unknown IDs | Evidence | 原因 |
| --- | --- | --- | --- | --- | --- |
| package-validity | pass | P0 | — | inspector、validator、materialization | 源码和最终制品结构有效 |
| critical-artifacts | pass | P0 | — | manifest、case docs、fixture | 必需文件存在并可解析 |
| goal-alignment | pass | P0 | — | SKILL.md、behavior trace | 目标、范围和授权一致 |
| capability-validity | pass | P0 | — | materialized questionTool、current trace | Codex 能使用 request_user_input |
| safety-permissions | pass | P0 | — | strict isolation、workspace diff | 无越权写入或宿主源码访问 |
| architecture-ownership | pass | P1 | — | architecture audit | runtime 管理交互状态 |
| release-evidence | fail | P1 | RC-F-001 | 7/7 covered；releaseOutcome failed | required trigger/router sanity 失败 |
| eval-validity | fail | P1 | RC-F-001 | case、fixture、10 个 trace | hard oracle 对可见输入不唯一 |
| eval-change-safety | not_applicable | P1 | — | 本轮无修改 | 没有 eval-driven change |

## Appendix C — Full Scorecard

| 维度 | 权重 | 分数 | 置信度 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- |
| 规范与包完整性 | 6 | 5.0 | high | — | — | 源码和最终制品有效 |
| 问题基础与实际价值 | 8 | 5.0 | high | — | — | current 能完成 baseline 未完成的澄清交接 |
| 调用策略、触发条件与 Context Pointer | 10 | 4.0 | high | — | RC-U-001 | 主体稳定，一个 strict near-miss mixed |
| 范围、边界与组合性 | 8 | 5.0 | high | — | — | 与 decision-grill 的职责清楚 |
| 程序与完成边界 | 10 | 5.0 | high | — | — | 三个 current trace 通过 |
| 最小充分控制与模型自由度 | 14 | 5.0 | high | — | — | 八条最小合同都有依据 |
| 信息层级、资源与渐进式披露 | 10 | 5.0 | high | — | — | 单一短正文，无 runtime sprawl |
| 职责归属与自然语言状态机风险 | 10 | 5.0 | high | — | — | runtime 管理状态，风险 low |
| 脚本与确定性自动化 | 7 | 5.0 | high | — | — | agent script 正确省略，fixture 已验证 |
| Eval 设计、Oracle 有效性与修改安全 | 9 | 3.0 | high | RC-F-001 | — | 一个 release hard oracle 不能使用 |
| 可靠性、安全与兼容性 | 4 | 3.0 | medium | — | RC-U-002 | Codex 有证据，Claude 行为未知 |
| 剪枝、事实源与变更纪律 | 4 | 5.0 | high | — | — | 没有规则沉积或重复 owner |

- **加权总分：** 92.8
- **原始质量带：** excellent
- **有效质量带：** excellent
- **复杂度上限原因：** 无；复杂度为 minimal。分数不覆盖 P1 gate failure。

## Appendix D — Finding Admission Records

### RC-F-001

- **Location：** `requirements-clarifier-routing-cases.json#existing_convention`；`plugins/ask-me/scripts/trigger-fixture.mjs#IMPLEMENTATION_REPO_FILES`；batch `20260814T163800Z-full-review-20260815-d89c02cd`
- **Exact claim：** release-counted `existing_convention` 把 no-load 设为高置信 hard oracle，但 visible prompt 和 fixture 没有唯一说明“同样的导出”是只复制唯一策略对象，还是交付可调用导出流程；十次运行各有五次采用两种解释，hard target 失败。
- **Affected scenario：** Codex project-default strict router/sanity，两个 participant Skills 同时可用。
- **Material impact：** 无效 hard oracle 阻断当前发布，并可能把 Skill 修改推向单一 reviewer 解释。
- **Direct evidence：** case prompt/expected/oracle；fixture 中的 `invoiceExportPolicy` 和 order list；10 个 trace；batch releaseOutcome。
- **Counterevidence：** description 明确“已有惯例时不要使用”；5/10 运行选择 neither；router validation 6/6 case 通过；没有 execution/isolation error。
- **Owner：** Eval
- **Minimal action：** 明确交付 artifact 和验收边界，或调整 oracle/case role；不要从当前 case 单独改 SKILL.md。
- **Validation：** strict case validator；相反标签 minimal pair；新的完整无过滤 required batch。

| Premise | Source role | Evidence | Status |
| --- | --- | --- | --- |
| router/sanity 是 required，defaultRuns=10，minimumPassRate=0.9 | manifest | evals/manifest.json router suite | supported |
| case 期望不加载任一 Skill，oracle confidence=high | eval case | existing_convention | supported |
| fixture 只有策略对象和 order list，没有可调用导出入口或验收 artifact | fixture | IMPLEMENTATION_REPO_FILES | supported |
| 五次加载 requirements-clarifier，五次加载 neither | runtime | router sanity report and traces | supported |

| Reachability kind | Path | Evidence | Status |
| --- | --- | --- | --- |
| execution-path | manifest router/sanity → existing_convention → 10 Codex runs → required target | route_match_rate=0.5，outcome=failed | supported |

该 P1 通过 Finding Admission Gate。问题、可达路径、影响、owner 和替代解释都已明确；claim 没有把 runner failure 扩大为 Skill defect。

## Appendix E — 适用专项审计

### Invocation / Context Pointer Audit

| Pointer | 目标材料 | 触发 branch | 意图前置 | 重复 branch | 重复正文身份 | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| frontmatter description | requirements-clarifier | 实施任务在只读检查后仍有高影响歧义 | 是 | 否 | 少量 | trigger validation、sanity | 保留；先补 RC-U-001 证据 |
| description 和正文中的 decision-grill pointer | 相邻协作访谈 Skill | 当前任务本身要求逐轮推演并形成共享理解 | 是 | 否 | 否 | router validation 20/20 对应运行 | 保留 |
| agents/openai.yaml default prompt | 显式调用入口 | 用户显式选择 Skill | 是 | 否 | 否 | explicit_clarifier 10/10 | 保留 |

### Minimum Effective Control Audit

#### 最小行为合同

1. 只在具体实现或修改任务经过只读检查后仍有高影响关键歧义时激活。
2. 先查对话、代码、配置、文档、惯例和已有决定，不重问可查事实。
3. 把剩余不确定项分为询问用户、采用默认或列为待验证。
4. 多个小歧义合起来决定功能形态时也要先澄清。
5. 先问上游选择；独立问题每轮最多三题，并只在选项准确时使用问题工具。
6. 要求冲突时指出冲突，让用户选择最小可行调整。
7. 没有关键歧义或用户停止时交接，并保留关键默认、待验证和未解决项。
8. 澄清期间不修改文件、不做原型、不开始实施。

#### 控制面

| Signal | Count / observation | Risk |
| --- | ---: | --- |
| Mandatory stages | 3：处理不确定项、提问、结束 | low |
| Hard gates | 1：只在关键歧义仍存在时提问 | low |
| Fixed intermediate artifacts | 0 | low |
| Prohibitions | 4 个主要安全或职责不变量 | low |
| Conditional branches | 询问、默认、验证、冲突、停止 | low |
| Fixed output fields | 3 个按需交接字段，可省略空项 | low |

#### 必要性映射与简化候选

| 当前行为块 | 改变的行为 | 依据 | 当前控制类型 | 模型默认能否处理 | 处理建议 | 删除或放宽风险 |
| --- | --- | --- | --- | ---: | --- | --- |
| 激活与 near-miss | 避免所有实现都进入澄清 | trigger corpus | invariant | 不稳定 | keep-invariant | 多余阻塞或静默决定 |
| 只读事实检查 | 避免重问可查事实 | mixed current/baseline | invariant | 不稳定 | keep-invariant | 用户负担和错误前提 |
| 询问/默认/验证 | 区分用户决定和技术证据 | mixed、engineering traces | invariant | 不稳定 | keep-invariant | 让用户替技术事实拍板 |
| 组合小歧义 | 识别合并后的功能影响 | combined trace | default | 部分 | keep-default | 多个静默默认改变成品 |
| 上游优先和每轮三题 | 控制依赖和认知负担 | release/diagnostic oracle | default | 部分 | keep-default | 无效下游问题或问题过多 |
| 工具、推荐和冲突 | 避免不准确选项与静默放宽 | case admission、正文 | invariant | 不稳定 | keep-invariant | 误导或验收冲突 |
| 停止与不实施 | 交还控制权并阻止越权 | current trace、workspace diff | invariant | 不稳定 | keep-invariant | 无休止提问或未授权实施 |

复杂度结论为 `minimal`，reducibility 为 `almost-none`。没有把启发式升级为固定 artifact，也没有自然语言状态机。

### Information Hierarchy Map

| 内容 | 类型 | 适用 branch | 当前位置 | 每次需要 | Pointer 或环境事实源 | 最小控制结论 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| 激活和 near-miss | in-file-reference | Skill discovery | description | 是 | catalog metadata | keep-invariant | 保留 |
| 三路不确定性处理 | in-file-step | 澄清开始 | SKILL.md | 是 | 正文 | keep-invariant | 保留 |
| 提问、推荐和冲突 | in-file-step | 需要用户决定 | SKILL.md | 否 | 正文和 tool schema | keep-invariant | 保留 |
| 停止和交接 | in-file-step | 无关键歧义或用户停止 | SKILL.md | 是 | 正文 | keep-invariant | 保留 |
| 对话、代码、配置、文档、惯例 | environment-lookup | 有材料时 | 工作区 | 否 | 环境事实源 | keep-invariant | 不缓存 |
| eval corpus 和 trace | disclosed-reference | 作者评测 | evals/ 和 .tmp/ | 否 | manifest | 不进入 runtime | 保持隔离 |

### Completion Boundary Audit

| 步骤或规则集 | 当前标准 | 清楚 | 可检查 | 要求充分 | 覆盖完整 | 提前完成风险 | 建议 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 事实检查 | 已说明或可查事实直接采用 | 是 | 是 | 是 | 是 | low | 保留 |
| 三路处理 | 每个剩余项被问、默认或列为验证 | 是 | 是 | 是 | 是 | low | 保留 |
| 当前问题前沿 | 上游优先；独立时最多三题 | 是 | 是 | 是 | 是 | low | 保留 |
| 冲突处理 | 指出具体冲突，让用户选最小调整 | 是 | 是 | 是 | 是 | low | 保留 |
| 停止和交接 | 无关键歧义或用户停止时交还控制权 | 是 | 是 | 是 | 是 | low | 保留 |
| 澄清安全边界 | 无文件修改、原型或实施 | 是 | 是 | 是 | 是 | low | 保留 |

### Architecture and Ownership

- **Skill 负责的策略：** 激活、事实检查、三路处理、问题顺序、冲突和停止。
- **Schema 或客户端负责的事实：** question id、选项结构、用户答复和工具可用性。
- **Runtime 负责的状态：** 会话、等待、答复顺序、取消和工具生命周期。
- **脚本候选：** 没有。歧义影响和返工成本需要语义判断。
- **仅属于 role 的约束：** 没有独立 role。
- **仅属于 eval 或 issue 的问题：** `RC-F-001`、`RC-U-001`、Claude 行为覆盖。
- **自然语言状态机风险：** low

### Scripts and Resources

- **已有脚本或正确省略：** agent-facing script 正确省略；作者侧 fixture 提供确定性 workspace。
- **接口、依赖和安全质量：** fixture 只导入 `node:fs/promises` 和 `node:path`；无 import-time 写入；写入限定 runner 的 workspaceRoot 和固定相对路径。
- **模型仍在重复的确定性逻辑：** 没有可独立脚本化的核心语义判断。
- **Reference 和 asset 可达性：** runtime 无 reference/asset；eval case 由 manifest 一层到达。
- **重复、scattering 与 co-location：** 核心流程在一个短文件；相邻 Skill 只保留互斥 pointer。
- **不必要缓存的环境事实：** 没有。
- **过期或孤立资源：** 没有 runtime 孤立资源。README 未获登记授权，本轮不更新。

### Eval Case Audit

#### 目标和错误代价

| 项目 | 判定 | 证据 |
| --- | --- | --- |
| Optimization policy | recall-first；router 为 balanced | 两份 trigger policy、behavior policy |
| False-negative cost | high | 漏触发可能静默决定用户可见结果、权限或验收 |
| False-positive cost | medium；router high | 单 Skill 误触通常可恢复；误路由到长访谈或双加载会阻断实施 |
| Policy rationale | 正负指标分开报告，不用总 accuracy 掩盖边界失败 | manifest、case policy、runner reports |

#### Eval 门禁

| Gate | 状态 | 证据 | 原因 |
| --- | --- | --- | --- |
| eval-validity | fail | RC-F-001 admission | 一个 release hard oracle 对 visible fixture 不唯一 |
| release-evidence | fail | 7/7 covered；releaseOutcome failed | trigger/sanity 和 router/sanity failed |
| eval-change-safety | not_applicable | 本轮未修改 Skill | 不允许当前失败直接驱动正文修改 |

#### Suite 构成

| 指标 | 数量或判定 |
| --- | ---: |
| Cases | 47 个 manifest-reachable；27 个 release case definition |
| Scenario families | 34 |
| Decision boundaries / minimal pairs | 21 个显式 minimal-counterexample 记录 |
| Representative cases | 16 |
| Regression cases | 2 |
| Boundary cases | 19 |
| Challenge cases | 0 |
| Diagnostic-only cases | 10 |
| Stale / ambiguous cases | 1：existing_convention |

#### Case Admission 结果

| Case group | 层级 | Role | Provenance | Oracle 置信度 | 前提充分 | Rule trace | 现实 | 决策 |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| trigger corpus 25 | trigger | representative/regression/boundary | synthetic/observed/boundary | high | 是 | 是 | 是 | release-counted；train 不进入发布 |
| router 除 existing_convention 外 8 | routing | representative/regression/boundary | derived/observed/boundary | high | 是 | 是 | 是 | release-counted |
| existing_convention | routing | boundary | boundary | 声明 high，实质不足 | 否 | 是 | 部分 | needs-adjudication |
| release behavior 3 | behavior | representative | derived | high | 是 | 是 | 是 | release-counted |
| behavior-diagnostic 10 | behavior | diagnostic | derived/mechanism-probe | high | 是 | 是 | 是 | diagnostic-only |

四份 case 文档都通过 validator。三份 required 文档使用 `--strict`，均 0 error、0 warning。结构 validator 不替代 `RC-F-001` 的语义裁决。

#### Trigger 或其它二元决策结果

| 指标 | 当前结果 | Baseline / previous | 解释 |
| --- | ---: | ---: | --- |
| trigger positive recall | 100%（21/21 runs） | 无 previous | validation 和 sanity 正例全加载 |
| trigger false-negative rate | 0% | 无 previous | 无漏触发 |
| trigger negative specificity | 95.8%（23/24 runs） | 无 previous | s04 误载 1/3 |
| trigger false-positive rate | 4.2%（1/24 runs） | 无 previous | strict sanity 因一次误载失败 |
| router exact-route rate | 93.3%（84/90 runs） | 无 previous | validation 59/60；sanity 25/30 |
| router owner-positive recall | 100%（30/30 runs） | 无 previous | owner 应加载时全部加载 |
| router owner-negative specificity | 90%（54/60 runs） | 无 previous | direct_plan_review 1 次和 existing_convention 5 次误载 owner |
| Mixed / uncertain cases | s04 1/3；existing_convention 5/10 | — | 前者为 RC-U-001；后者为 RC-F-001 |

#### Behavior、outcome 和 cost 证据

| Scenario family | With Skill | Baseline | Quality delta | Token/time delta | 方差 | 证据强度 |
| --- | --- | --- | --- | --- | --- | --- |
| fact-default-user-intent | 读文档，只问迁移策略，消费答复并交接 | 重复拆成两个文本问题，未消费 scripted reply | 明显正向 | +23,443 tokens；+4,072 ms | 各 1 pair | medium |
| combined-small-ambiguities | 一轮三题，消费三项答复并交接 | 只在 final 中列问题，未消费答复 | 明显正向 | +24,657 tokens；+13,157 ms | 各 1 pair | medium |
| engineering-validation | 问三个客观输入，保留技术验证和未解决项 | 只在 final 列输入缺口 | 小到中等正向 | +14,761 tokens；+5,581 ms | 各 1 pair | medium |

三个 current 合计 146,898 tokens / 87,465 ms；baseline 合计 84,037 tokens / 64,655 ms。Skill 多 62,861 tokens 和 22,810 ms，主要来自真实问题工具和第二轮交接。没有已声明成本预算，因此成本只作为 tradeoff，不形成 finding。

#### Failure triage

| Case / assertion | Failure class | 可复现 | Root owner | 动作 | 理由 |
| --- | --- | ---: | --- | --- | --- |
| s04_complete_account_spec 1/3 | model-variance / unknown | 混合 | Unknown | collect-more-data | 相近 n06 为 0/3；一次 run 在初次检查中同时读取 Skill |
| existing_convention 5/10 | oracle-defect | 是 | Eval | fix-eval-first | visible artifact scope 不唯一；两种解释各 5 次 |
| natural-mixed-ambiguity qualitative | none | 是 | — | accept | current 三项 check 均通过 |
| natural-combined-ambiguities qualitative | none | 是 | — | accept | current 三项 check 均通过 |
| natural-engineering-evidence qualitative | none | 是 | — | accept | current 五项 check 均通过 |

#### Eval-driven 修改决策

- **修改内容：** 无生产修改。
- **受影响场景族：** project-convention-vs-ambiguity。
- **为什么不是 Skill defect：** `existing_convention` 的可见输入不能排除两种合理交付范围；`s04` 只有混合样本。
- **原始失败证据：** route match 5/10；strict negative false positive 1/3。
- **Minimal pair / 相反标签风险：** 修 oracle 后必须保留 implementation_clarify、fully_specified_helper 和已有惯例的相反边界。
- **Validation、sanity 和 regression 重跑：** 当前未修改，因此未运行 change regression。
- **Quality delta：** 不适用。
- **Context / branch / maintenance delta：** 0；生产正文未变。
- **决策：** fix-eval-first

#### Eval 维度

- **分数：** 3.0
- **置信度：** high
- **适用评分上限：** 无自动上限；实际因 invalid release oracle 和 failed release evidence 扣分。
- **摘要：** suite 结构、baseline、trace、错误代价和覆盖可靠，但当前不能作为发布通过或 Skill 修改依据。

#### 停止决定

停止扩写 Skill。先修 eval oracle，再运行新的完整 batch。非发布 `behavior-diagnostic` 没有补跑，因为三项 release qualitative trace 已足以裁决，且该 suite 不测试两个 trigger failure 的 unit under test。

## Appendix F — 执行与当前性记录

### 构建和来源身份

- Git HEAD：`58537006e874103237fdc020148c40377fa33879`
- batch source digest：`sha256:41bf1612dee2503a1c10159f20cfd8504c8cc602dd2bb37edeb14ee3d54807c8`
- source `inScopeDirty=false`
- 源 `SKILL.md` SHA-256：`80e0c8c5fa226d7153ee65f9f73deb5f15b9d09d9859b5d4d03bceb95af4e5f1`
- materialized Codex `SKILL.md` SHA-256：`663ab8ef84ab6a6cfb72ca7d6125aef6b3caa21bda7b7d37fa485a91a833890e`
- CLI dist/index.js SHA-256：`d5c423f974aa0e162133acac71cb4f55b7fc8e082ed252b3830083bab6691e72`
- Node：`v24.14.1`；pnpm：`10.33.0`
- Model：`gpt-5.6-luna`；Codex CLI：`0.147.0`；strict isolation；Full Access runner management。

### 命令和状态

| 命令 | 状态 | 说明 |
| --- | ---: | --- |
| `pnpm build` | 0 | 共享构建证据 |
| `node .agents/skills/create-aw-plugin/scripts/validate_plugin.mjs plugins/ask-me --json` | 0 | `ok=true`；仅 release intent / production unchanged warning |
| `pnpm plugin:test ask-me --platform codex --scope project` | 0 | 7/7 |
| `node .agents/skills/skill-review/scripts/inspect_skill_target.mjs plugins/ask-me --format json` | 0 | source inspector 无 issue |
| required 3 份 `validate_eval_cases.mjs ... --strict --format json` | 0 | 全部 0 error、0 warning |
| diagnostic 1 份 `validate_eval_cases.mjs ... --format json` | 0 | 0 error、0 warning |
| `pnpm plugin:eval ask-me --skill requirements-clarifier --batch-name full-review-20260815` | 1 | batch complete；7/7 covered；releaseOutcome failed |
| `inspect_skill_target.mjs plugins/ask-me --evaluation <raw/evaluation.json> --format json` | 1 | 正确反映 evaluation.failed 和 qualitative-review warning |

本报告是 full 模式，不是 release 模式。它未执行 external current-check source 核对。真实模型证据只覆盖 Codex。正式发布会使用 `review:publish` 写报告并封存批次；本轮不运行 `review:release`。
