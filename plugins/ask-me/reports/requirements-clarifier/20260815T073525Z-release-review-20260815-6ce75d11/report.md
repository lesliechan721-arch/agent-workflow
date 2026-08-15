# requirements-clarifier 评审

## 结论

- **设计结论：** needs-fixes
- **发布就绪度：** blocked
- **复杂度：** minimal
- **证据：** coverage `100%`；confidence `high`（0.99）

**判断：**

生产 Skill 用一个短流程解决实施前关键歧义。三个 release behavior current trace 均通过定性复核；单 Skill trigger 的发布正例 recall 和负例 specificity 都是 100%。当前阻断不是生产正文缺陷：一个 release-counted routing case 要求评审“这份迁移计划”，但没有提供计划内容或 fixture；失败 run 在空工作区搜索后同时读取两个 participant Skill，使完整 Codex batch 的 `releaseOutcome=failed`。

旧报告中的 `existing_convention` oracle 歧义已经关闭。当前 case 明确复制可调用的 `exportInvoicesCsv(rows)` 及完整接口和行为，fixture 也包含该函数；本轮 case 为 9/10，相反 minimal pair 为 10/10。当前证据不支持修改生产 `SKILL.md`。

**下一步：**

执行 `A-01`。

## 必须处理

### RC-F-001 `direct_plan_review` 缺失被评审计划 fixture — P1

**为什么重要：**

该 case 属于 required router/validation。它的 10 次运行中有 1 次同时加载 `requirements-clarifier` 和 `decision-grill`，违反 `forbidMultipleSkillLoads`，使完整 release batch 失败。失败 trace 显示模型先搜索不存在的计划，再读取两个 Skill；因此当前结果不能安全归因为生产 Skill defect。

**证据：**

- `requirements-clarifier-routing-cases.json#direct_plan_review`；
- `plugins/ask-me/scripts/trigger-fixture.mjs#setupTriggerWorkspace`；
- batch `20260815T073525Z-release-review-20260815-6ce75d11` 的 `router-validation-project-default.json#direct_plan_review.runs[2]`；
- 完整 admission 见 Appendix D 的 `RC-F-001`。

**建议：**

给 case 提供一份小型、脱敏、可直接评审的迁移计划 fixture，并保留 neither oracle。不要从当前失败单独扩写生产 Skill。

**完成标准：**

case 通过 strict validator；trace 实际读取计划；相邻 implementation/decision minimal pair 不回归；新的无过滤完整 release batch 7/7 covered，且 `releaseOutcome` 不为 failed。

## 高价值改进

没有独立于 `RC-F-001` 的已证实 P2 项。其它 mixed case 先按 `RC-U-001` 补证据，不增加生产规则。

## 已经可靠的部分

- source、Codex project/user materialization 和 metadata 结构有效；inspector 除 evaluation result 外没有 package issue。
- required trigger 的 21 个正例 runs 与 24 个负例 runs 全部正确；三个 release behavior current trace 全部满足 oracle，且 workspace 无改动。
- 正文约 504 tokens；状态、答复顺序、等待和工具生命周期由 runtime 管理，没有高风险自然语言状态机。

## 决策关键的证据缺口

| ID | 缺少的证据 | 当前影响 | 获得方式 |
| --- | --- | --- | --- |
| RC-U-001 | 修复 fixture 后的 router 边界稳定性 | mixed case 的真实方差和 owner 尚不能精确分离 | 修 fixture 后运行新的完整 paired batch，并复核所有不同路由 trace |
| RC-U-002 | Claude 真实模型行为 | 行为结论只覆盖 Codex | 使用受支持 Claude runner 运行等价 suite，或限制行为声明范围 |

## 发布限制

| Gate | 状态 | 对发布的影响 | Action ID |
| --- | --- | --- | --- |
| release-evidence | fail | 7/7 target covered，但 required router/validation 失败，`releaseOutcome=failed` | A-01 |
| eval-validity | fail | `direct_plan_review` 缺失关键 fixture，不能驱动 Skill 修改或发布通过 | A-01 |

安全执行结果：source 和 materialized inspector 已运行；三份发布 case 文档 strict validator 均为 0 error、0 warning；diagnostic 文档兼容 validator 为 0 error、0 warning；共享 `plugin:test` 为 7/7。完整模型 batch 已完成，行为 qualitative review 已完成。真实模型行为证据只覆盖 Codex。

## 质量概览

| 领域 | 状态 | 说明 |
| --- | --- | --- |
| 触发与范围 | strong | 单 Skill trigger 45/45；router exact route 96/100，少量 mixed 需要补证据 |
| 指令、控制与架构 | strong | 三个 current behavior case 通过；控制短且职责正确 |
| 资源、脚本与披露 | strong | agent-facing script 正确省略；作者测试和 fixture 安全边界清楚 |
| Eval 与发布证据 | weak | suite 主体可靠，但一个 required case 缺失实际评审对象，当前发布失败 |

## 行动路线

### 现在

1. **`A-01`：** 修复 `RC-F-001` 的 fixture，保留原 oracle，并运行新的完整无过滤 release batch。

### 下一步

1. **`A-02`：** 新 batch 仍出现 mixed 时，增加 paired runs，分别归因模型方差、client routing 或 Skill description；引用 `RC-U-001`。

### 暂不处理

1. **`A-03`：** 等可用 Claude 模型 runner 后关闭 `RC-U-002`；当前报告不把 Codex 证据外推到 Claude。

## 停止与重新打开条件

**现在停止，因为：**

生产正文、全部发布 case、fixture、current/baseline trace 和旧 finding 都已复核。当前唯一发布阻断有明确 Eval owner；继续扩写 Skill 会增加回归风险，没有净收益。

**仅在出现以下情况时重新打开：**

- `RC-F-001` 的 fixture 已修复并有新的完整 batch；
- 固定 router case 出现稳定、可归因的回归；
- 新的 observed failure、normative requirement 或 structural contradiction 出现；
- Claude 等价模型证据可用。

# requirements-clarifier 评审技术附录

## Appendix A — 评审范围与合同

| 项目 | 从材料提取的结论 | 状态 | Evidence |
| --- | --- | --- | --- |
| 目标问题 | 在具体实现前，用最少问题补齐会改变结果、权限、范围或验收的关键歧义 | known | `SKILL.md:6-33` |
| 已观察失败 | required router/validation 中 `direct_plan_review` 1/10 同时加载两个 Skill | known | current batch router report and trace |
| 成功标准 | 先查事实；不确定项分为问、默认、验证；只问必要问题；停止并交接 | known | `SKILL.md:12-33`、behavior oracle |
| 目标环境或客户端 | Codex project model；Codex project/user materialization；插件静态声明 Codex/Claude | known | manifest、plugin.json、batch environment |
| 范围外事项 | 纯只读分析、完整规范、明确惯例、内部可逆选择、授权默认、协作决策访谈 | known | description、trigger/router corpus |
| 相邻 Skill | `decision-grill` | known | 两个 description、router suite |
| 发布要求 | release 报告正式发布并封存；不登记 README | known | 用户授权、plugin review reference |

正式发布授权：已授权。README 登记授权：未授权。本轮不运行 `review:release`，不修改 README、生产 Skill、eval corpus 或脚本。

## Appendix B — 完整发布门禁

| Gate ID | 状态 | 严重性 | Finding / Unknown IDs | Evidence | 原因 |
| --- | --- | --- | --- | --- | --- |
| package-validity | pass | P0 | — | source/final inspector、materialization | 源码和最终制品有效 |
| critical-artifacts | pass | P0 | — | manifest、case、fixture、metadata | 必需文件存在并可解析 |
| goal-alignment | pass | P0 | — | SKILL.md、behavior trace | 目标、范围和不实施边界一致 |
| capability-validity | pass | P0 | — | materialized `request_user_input`、current trace | Codex 工具能力可用 |
| safety-permissions | pass | P0 | — | strict isolation、host-source audit、workspace diff | 无越权写入或宿主源码访问 |
| architecture-ownership | pass | P1 | — | architecture audit | runtime 管理交互状态 |
| release-evidence | fail | P1 | RC-F-001 | 7/7 covered；releaseOutcome failed | required router/validation 失败 |
| eval-validity | fail | P1 | RC-F-001 | case、fixture、run 3 trace | case 未提供所称迁移计划 |
| eval-change-safety | not_applicable | P1 | — | 本轮无生产修改 | 没有 eval-driven 生产修改 |

## Appendix C — Full Scorecard

| 维度 | 权重 | 分数 | 置信度 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- |
| 规范与包完整性 | 6 | 5.0 | high | — | — | 源码和最终制品有效 |
| 问题基础与实际价值 | 8 | 5.0 | high | — | — | current 在关键场景优于 baseline |
| 调用策略、触发条件与 Context Pointer | 10 | 4.0 | high | — | RC-U-001 | trigger 稳定，router 有少量 mixed |
| 范围、边界与组合性 | 8 | 5.0 | high | — | — | 与 decision-grill 和一次性评审边界清楚 |
| 程序与完成边界 | 10 | 5.0 | high | — | — | current behavior 全部通过 |
| 最小充分控制与模型自由度 | 14 | 5.0 | high | — | — | 七条最小合同均有依据 |
| 信息层级、资源与渐进式披露 | 10 | 5.0 | high | — | — | 单一短正文，无 runtime sprawl |
| 职责归属与自然语言状态机风险 | 10 | 5.0 | high | — | — | runtime 管理状态，风险 low |
| 脚本与确定性自动化 | 7 | 5.0 | high | — | — | agent script 正确省略；作者脚本已审计和测试 |
| Eval 设计、Oracle 有效性与修改安全 | 9 | 3.0 | high | RC-F-001 | — | 一个 release fixture 前提不足 |
| 可靠性、安全与兼容性 | 4 | 3.0 | medium | — | RC-U-002 | Codex 有证据，Claude 行为未知 |
| 剪枝、事实源与变更纪律 | 4 | 5.0 | high | — | — | 旧 finding 已重新裁决，无规则沉积 |

- **加权总分：** 92.8
- **原始质量带：** excellent
- **有效质量带：** excellent
- **复杂度上限原因：** 无；复杂度为 minimal。分数不覆盖 P1 gate failure。

## Appendix D — Finding Admission Records

### RC-F-001

- **Location：** `requirements-clarifier-routing-cases.json#direct_plan_review`；`plugins/ask-me/scripts/trigger-fixture.mjs#setupTriggerWorkspace`；batch router validation run 3
- **Exact claim：** release-counted case 要求评审“这份迁移计划”，但没有提供计划内容或 workspace fixture；失败 run 在空工作区搜索后同时读取两个 participant Skill，使 required router/validation 失败。
- **Affected scenario：** Codex project-default strict router/validation 的一次性、只读迁移计划评审 near-miss。
- **Material impact：** 当前发布证据失败；该无效前提若驱动 Skill 修改，会造成无依据的生产规则增加。
- **Direct evidence：** case query/shape；default fixture 行为；run 3 completed command trace；batch summary。
- **Counterevidence：** 其余 9/10 runs 正确 neither；两个 description 都排除一次性评审；run 没有 execution error；历史报告也记录该 case 1/10 owner 误载。
- **Owner：** Eval
- **Minimal action：** 增加真实计划 fixture，保留 neither oracle；不修改生产 Skill。
- **Validation：** strict validator；trace 读取计划；相邻 minimal pair；新完整 release batch。

| Premise | Source role | Evidence | Status |
| --- | --- | --- | --- |
| router/validation required，defaultRuns=10，禁止任何多 Skill 加载 | project manifest | `evals/manifest.json#suites/router` | supported |
| query 把一份迁移计划作为评审对象 | eval case | `direct_plan_review.query` | supported |
| case 没有计划内容或 workspace fixture，default fixture 不写文件 | eval/fixture | case shape；`setupTriggerWorkspace` | supported |
| run 3 搜索计划后用一个命令读取两个 Skill | runtime | raw router report event trace | supported |

| Reachability kind | Path | Evidence | Status |
| --- | --- | --- | --- |
| execution-path | manifest router/validation → direct_plan_review → run 3 → search missing plan → read both Skills → multiple-load failure | route counts 9 neither / 1 both；required target failed | supported |

该 P1 通过 Finding Admission Gate。问题、可达路径、发布影响、counterevidence 和 Eval owner 都有直接证据；claim 没有扩大为生产 Skill defect。

## Appendix E — 适用专项审计

### Invocation / Context Pointer Audit

| Pointer | 目标材料 | 触发 branch | 意图前置 | 重复 branch | 重复正文身份 | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| frontmatter description | requirements-clarifier | 具体实施在只读检查后仍有高影响歧义 | 是 | 否 | 少量 | trigger 45/45；router | 保留 |
| description 和正文中的 decision-grill pointer | 相邻协作访谈 Skill | 当前任务本身要求逐轮推演和共享理解 | 是 | 否 | 否 | router implementation/decision pairs | 保留 |
| `agents/openai.yaml` default prompt | 显式调用入口 | 用户显式选择 Skill | 是 | 否 | 否 | explicit cases 13/13 runs | 保留 |

### Minimum Effective Control Audit

#### 最小行为合同

1. 只在具体实现或修改任务经过只读检查后仍有高影响关键歧义时激活。
2. 先查对话、代码、配置、文档、惯例和已有决定，不重问可查事实。
3. 把剩余不确定项分为询问用户、采用默认或列为待验证。
4. 多个小歧义合起来决定功能形态时也先澄清。
5. 先问上游选择；独立问题每轮最多三题，只在选项准确时使用问题工具。
6. 要求冲突时指出冲突，让用户选择最小可行调整。
7. 无关键歧义或用户停止时交接；澄清期间不修改文件、不做原型、不开始实施。

#### 控制面

| Signal | Count / observation | Risk |
| --- | ---: | --- |
| Mandatory stages | 3：处理不确定项、提问、结束 | low |
| Hard gates | 1：只在关键歧义仍存在时提问 | low |
| Fixed intermediate artifacts | 0 | low |
| Prohibitions | 4 个职责或安全不变量 | low |
| Conditional branches | 询问、默认、验证、冲突、停止 | low |
| Fixed output fields | 3 个按需交接字段，可省略空项 | low |

#### 必要性映射与简化候选

| 当前行为块 | 改变的行为 | 依据 | 当前控制类型 | 模型默认能否处理 | 处理建议 | 删除或放宽风险 |
| --- | --- | --- | --- | ---: | --- | --- |
| 激活与 near-miss | 避免所有实现或只读任务进入澄清 | trigger/router corpus | invariant | 不稳定 | keep-invariant | 多余阻塞或静默决定 |
| 只读事实检查 | 避免重问可查事实 | mixed current/baseline trace | invariant | 不稳定 | keep-invariant | 用户负担和错误前提 |
| 询问/默认/验证 | 区分用户决定和技术证据 | mixed、engineering traces | invariant | 不稳定 | keep-invariant | 让用户替技术事实拍板 |
| 组合小歧义 | 识别合并后的功能影响 | combined trace | default | 部分 | keep-default | 多个静默默认改变成品 |
| 上游优先和每轮三题 | 控制依赖和认知负担 | release/diagnostic oracle | default | 部分 | keep-default | 无效下游问题或问题过多 |
| 工具、推荐和冲突 | 避免不准确选项与静默放宽 | 正文、case admission | invariant | 不稳定 | keep-invariant | 误导或验收冲突 |
| 停止与不实施 | 交还控制权并阻止越权 | current trace、workspace diff | invariant | 不稳定 | keep-invariant | 无休止提问或未授权实施 |

复杂度结论为 `minimal`，reducibility 为 `almost-none`。没有固定中间 artifact 或自然语言 runtime 状态机。

### Information Hierarchy Map

| 内容 | 类型 | 适用 branch | 当前位置 | 每次需要 | Pointer 或环境事实源 | 最小控制结论 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| 激活和 near-miss | in-file-reference | Skill discovery | description | 是 | catalog metadata | keep-invariant | 保留 |
| 三路不确定性处理 | in-file-step | 澄清开始 | SKILL.md | 是 | 正文 | keep-invariant | 保留 |
| 提问、推荐和冲突 | in-file-step | 需要用户决定 | SKILL.md | 否 | 正文和 tool schema | keep-invariant | 保留 |
| 停止和交接 | in-file-step | 无关键歧义或用户停止 | SKILL.md | 是 | 正文 | keep-invariant | 保留 |
| 对话、代码、配置、文档、惯例 | environment-lookup | 有材料时 | workspace | 否 | 环境事实源 | keep-invariant | 不缓存 |
| eval corpus 和 trace | disclosed-reference | 作者评测 | evals/ 和 batch | 否 | manifest | 不进入 runtime | 保持隔离 |

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
- **脚本候选：** 无。歧义影响和返工成本需要语义判断。
- **仅属于 role 的约束：** 无独立 role。
- **仅属于 eval 或 issue 的问题：** `RC-F-001`、`RC-U-001`、Claude 行为覆盖。
- **自然语言状态机风险：** low

### Scripts and Resources

- **已有脚本或正确省略：** runtime agent-facing script 正确省略；插件作者侧有 `contract.test.mjs` 和共享 `trigger-fixture.mjs`。
- **接口、依赖和安全质量：** fixture 只导入 `node:fs/promises` 与 `node:path`，无 import-time 写入；固定相对路径写入 runner 的 `workspaceRoot`。contract test 只导入 Node built-ins 和本地 fixture，使用 `mkdtemp`，并在 `finally` 中清理；无网络或子进程。
- **模型仍在重复的确定性逻辑：** 核心歧义判断不适合脚本化。
- **Reference 和 asset 可达性：** runtime 无 reference/asset；eval case 由 manifest 一层到达。
- **重复、scattering 与 co-location：** 核心流程在一个短文件；相邻 Skill 只保留互斥 pointer。
- **不必要缓存的环境事实：** 无。
- **过期或孤立资源：** 无 runtime 孤立资源。README 未获登记授权，本轮不更新。

### Eval Case Audit

#### 目标和错误代价

| 项目 | 判定 | 证据 |
| --- | --- | --- |
| Optimization policy | trigger/behavior 为 recall-first；router 为 balanced | 三份 required case policy |
| False-negative cost | high | 漏触发可能静默决定用户可见结果、权限或验收 |
| False-positive cost | medium；router high | 单 Skill 误触可恢复；长访谈或双加载会阻断原任务 |
| Policy rationale | 正负指标分开报告，不用总 accuracy 掩盖边界失败 | manifest、case policy、runner reports |

#### Eval 门禁

| Gate | 状态 | 证据 | 原因 |
| --- | --- | --- | --- |
| eval-validity | fail | RC-F-001 admission | 一个 release case 缺失它声明的评审对象 |
| release-evidence | fail | 7/7 covered；releaseOutcome failed | router/validation failed |
| eval-change-safety | not_applicable | 本轮无生产修改 | 没有 eval-driven 生产修改 |

#### Suite 构成

| 指标 | 数量或判定 |
| --- | ---: |
| Manifest-reachable cases | 48 |
| Release case definitions | 28 |
| All scenario families | 34 |
| Release scenario families | 19 |
| Decision boundaries / minimal pairs | 17 个显式 minimal-counterexample |
| Representative cases | 16（release 11） |
| Regression cases | 2 |
| Boundary cases | 20（release 15） |
| Diagnostic-only cases | 10 |
| Stale / ambiguous cases | 1：`direct_plan_review` fixture 前提不足 |

#### Case Admission 结果

| Case group | 层级 | Role | Provenance | Oracle 置信度 | 前提充分 | Rule trace | 现实 | 决策 |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| release trigger 15 | trigger | representative/regression/boundary | synthetic/observed/boundary | high | 是 | 是 | 是 | release-counted |
| router 除 direct_plan_review 外 9 | routing | representative/regression/boundary | derived/observed/boundary | high | 是 | 是 | 是 | release-counted |
| direct_plan_review | routing | boundary | boundary | 声明 high，实质不足 | 否 | 是 | 否 | needs-adjudication / fix-fixture-first |
| release behavior 3 | behavior | representative | derived | high | 是 | 是 | 是 | release-counted，定性通过 |
| behavior-diagnostic 10 | behavior | diagnostic | derived/mechanism-probe | high | 是 | 是 | 是 | diagnostic-only，默认未运行 |

三份 required 文档 strict validator 均为 0 error、0 warning；diagnostic 文档兼容 validator 为 0 error、0 warning。结构 validator 不替代 `RC-F-001` 的语义裁决。

#### Trigger 或其它二元决策结果

| 指标 | 当前结果 | Baseline / previous | 解释 |
| --- | ---: | ---: | --- |
| trigger positive recall | 100%（21/21） | 无 previous | validation 和 sanity 正例全加载 |
| trigger false-negative rate | 0% | 无 previous | 无漏触发 |
| trigger negative specificity | 100%（24/24） | 无 previous | required negative 全部未加载 |
| trigger false-positive rate | 0% | 无 previous | 无误载 |
| router exact-route rate | 96%（96/100） | previous 未做同 corpus 比较 | 只有 direct_plan_review 因双加载使 target 失败 |
| router owner-positive recall | 97.5%（39/40） | — | approved_plan_gap 1 次 neither |
| router owner-negative specificity | 96.7%（58/60） | — | direct_plan_review 与 existing_convention 各 1 次 owner 误载 |
| Mixed / uncertain cases | 4 | — | decision_interview、approved_plan_gap、direct_plan_review、existing_convention 各 1 次不同路由 |

#### `existing_convention` 重新裁决

旧 finding 的关键前提不再成立：当前 prompt 明确目标入口、复制源函数、范围、字段、权限、返回格式和允许变化；`implementation_repo` 中的 `exportInvoicesCsv(rows)` 是可调用完整实现。current `existing_convention` 为 9/10，`existing_policy_missing_flow` 为 10/10。误载 run 读取 Skill 后仍明确结论为“无需澄清”，没有重现旧报告的 5/10 两种 artifact 解释。当前 oracle 为 high-confidence、release-counted；残余 1/10 记为 model variance，不重新发布旧 finding。

#### Behavior、outcome 和 cost 证据

| Scenario family | With Skill | Baseline | Quality delta | Token/time delta | 方差 | 证据强度 |
| --- | --- | --- | --- | --- | --- | --- |
| fact-default-user-intent | 读文档，只问迁移行为，消费答复并交接 | 问 3 题，新增迁移和拦截范围缺口 | 明显正向 | +1,741 tokens；-3,685 ms | 各 1 pair | medium |
| combined-small-ambiguities | 一轮三题，消费三项答复并交接 | 同样完成三题和交接 | 基本相当 | +11,842 tokens；-3,869 ms | 各 1 pair | medium |
| engineering-validation | 问 3 个客观输入，保留可行性待验证并交接 | 不提问，列出输入缺口 | 小到中等正向 | +27,246 tokens；+9,476 ms | 各 1 pair | medium |

三个 current 合计 149,069 tokens / 83,580 ms；baseline 合计 108,240 tokens / 81,658 ms。Skill 多 40,829 tokens 和 1,922 ms。没有成本预算；成本作为 tradeoff，不形成独立 finding。

#### Failure triage

| Case / assertion | Failure class | 可复现 | Root owner | 动作 | 理由 |
| --- | --- | ---: | --- | --- | --- |
| direct_plan_review 1/10 双加载 | fixture-defect | 两个 batch 各见 1 次 owner 误载 | Eval | fix-fixture-first | clean session 没有所称计划，失败 trace 先搜索空 workspace |
| existing_convention 1/10 owner load | model-variance | 混合 | Runtime/unknown | accept at threshold | oracle 与 fixture 已一致，opposite pair 10/10 |
| decision_interview 1/10 neither | model-variance | 混合 | Runtime/decision-grill | collect-more-data | requirements-clarifier 未误载，route rate 达 0.9 |
| approved_plan_gap 1/10 neither | model-variance | 混合 | Runtime/unknown | collect-more-data | case 合法，9/10 owner load |
| explicit_clarifier 首轮 WebSocket 中断 | runtime-or-tool-defect | 否 | Runtime | recovered | 同 batch 恢复后 10/10，最终 target complete |
| 三个 release behavior current | none | 是 | — | accept | current 全部 oracle checks 通过 |

#### Eval-driven 修改决策

- **修改内容：** 无生产修改，也未修改 eval corpus。
- **受影响场景族：** plan-review-vs-interview、project-convention-vs-ambiguity。
- **为什么不是 Skill defect：** `direct_plan_review` 的必要输入缺失；`existing_convention` 的旧歧义已被当前 corpus 消除。
- **原始失败证据：** direct_plan_review route 9 neither / 1 both。
- **Minimal pair / 相反标签风险：** 修 fixture 后必须保留 implementation_clarify、implementation_grill、fully_specified_helper 和 existing-convention pair。
- **Validation、sanity 和 regression 重跑：** 当前未修改，因此 change regression 不适用。
- **Quality delta：** 不适用。
- **Context / branch / maintenance delta：** 0；生产正文未变。
- **决策：** fix-eval-first

#### Eval 维度

- **分数：** 3.0
- **置信度：** high
- **适用评分上限：** 无机械上限；实际因 invalid release fixture 和 failed release evidence 扣分。
- **摘要：** suite、baseline、trace、错误代价和大部分 oracle 可靠，但当前不能作为发布通过或 Skill 修改依据。

#### 停止决定

停止扩写 Skill。先修复 eval fixture，再运行新的完整 batch。非发布 `behavior-diagnostic` 不执行，因为默认完整 release 只包含 `requiredForRelease` suites，且它不定位当前 router failure。

## Appendix F — 历史 finding、来源当前性与执行记录

### 历史 finding 关闭

| 历史 ID | 旧结论 | 当前证据 | 关闭结论 |
| --- | --- | --- | --- |
| 旧报告 RC-F-001 (`existing_convention`) | prompt/fixture artifact 边界不唯一，5/10 | 当前 prompt 明确复制可调用函数及接口/行为；fixture 有函数；current 9/10；opposite 10/10 | closed；不再是 oracle defect |
| 旧报告 RC-U-001 (`s04_complete_account_spec`) | 1/3 误载 | 当前 0/3，且 n06 0/3 | 当前 batch 未复现；不保留为决策 unknown |

### current-check 官方来源

source-map 中五个 current-check 官方来源已于 **2026-08-15** 重新打开并核验：

- [Agent Skill specification](https://agentskills.io/specification)：结构、frontmatter、渐进披露和文件引用；
- [Best practices](https://agentskills.io/skill-creation/best-practices)：真实问题基础、context、控制强度、默认、程序和 validation loop；
- [Optimizing descriptions](https://agentskills.io/skill-creation/optimizing-descriptions)：description、现实 trigger query、near-miss、重复运行和 train/validation；
- [Using scripts](https://agentskills.io/skill-creation/using-scripts)：依赖、相对路径、非交互、`--help` 和结构化输出；
- [Evaluating skills](https://agentskills.io/skill-creation/evaluating-skills)：current/baseline、clean context、assertion、trace、成本和迭代。

没有用第三方 heuristic 形成 P0/P1。正式规范、包内证据和 reviewer inference 在本报告中分开记录。

### 构建、来源与环境身份

- batch：`20260815T073525Z-release-review-20260815-6ce75d11`
- source commit：`154923cee33855db69cdee66444b07638551e14f`
- batch source digest：`sha256:22cbb01de4520be97bc81c9328c1215c987bd945fd5af6e97889b30eaff63bdf`
- source `inScopeDirty=false`
- source `SKILL.md` SHA-256：`80e0c8c5fa226d7153ee65f9f73deb5f15b9d09d9859b5d4d03bceb95af4e5f1`
- materialized Codex `SKILL.md` SHA-256：`663ab8ef84ab6a6cfb72ca7d6125aef6b3caa21bda7b7d37fa485a91a833890e`
- plugin config digest：`sha256:e615b1f809e169fad34b9f0a401be7516b9ffec3acfadab9c6e8be469b7204ed`
- bundle digest：`sha256:0fbee78549cd05dda6d18f3821344cb7f7f781727d089cc638c2c3d7460fbb33`
- CLI `dist/index.js` SHA-256：`d5c423f974aa0e162133acac71cb4f55b7fc8e082ed252b3830083bab6691e72`
- Node：`v24.14.1`；pnpm：`10.33.0`
- Model：`gpt-5.6-luna`；Codex CLI：`0.147.0`；strict isolation；process management `managed`；`descendantCleanupGuaranteed=true`。

### 命令和状态

| 命令 | 状态 | 说明 |
| --- | ---: | --- |
| `pnpm build` | 0 | 共享前置证据 |
| `node .agents/skills/create-aw-plugin/scripts/validate_plugin.mjs plugins/ask-me --json` | 0 | 共享前置证据；`ok=true`，仅 release intent / production unchanged warning |
| `pnpm plugin:test ask-me --platform codex --scope project` | 0 | 共享前置证据；7/7 |
| `inspect_skill_target.mjs plugins/ask-me --format json` | 0 | source inspector 无 issue |
| required 3 份 `validate_eval_cases.mjs ... --strict --format json` | 0 | 全部 0 error、0 warning |
| diagnostic 1 份 `validate_eval_cases.mjs ... --format json` | 0 | 0 error、0 warning |
| `pnpm plugin:eval ask-me --skill requirements-clarifier --batch-name release-review-20260815` | 1 | 首轮 WebSocket 中断；5/7 covered，checkpoint incomplete |
| `pnpm plugin:eval ask-me --skill requirements-clarifier --batch-id 20260815T073525Z-release-review-20260815-6ce75d11` | 1 | 同批恢复；7/7 covered、complete；releaseOutcome failed |
| `inspect_skill_target.mjs plugins/ask-me --evaluation <latest raw/evaluation.json> --format json` | 1 | 正确报告 `evaluation.failed` 和 qualitative-review warning；final artifacts 无结构 issue |
| `validate_scorecard.mjs <review-scorecard.json> --format json` | 0 | schema 合法；decision 为 needs-fixes / blocked |

本报告是 release 模式。完整 target 已 `complete`，但失败 target 和定性裁决仍按 trace 归因。真实模型证据只覆盖 Codex。本轮没有 eval-driven 生产修改，因此 `eval-change-safety=not_applicable`。
