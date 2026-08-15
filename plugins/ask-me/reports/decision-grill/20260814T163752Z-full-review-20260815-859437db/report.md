# `decision-grill` 评审

## 结论

- **设计结论：** needs-fixes
- **发布就绪度：** blocked
- **复杂度：** proportionate
- **证据：** coverage `100%`；confidence `high`

**判断：**

生产 Skill 的职责、流程和控制强度基本正确，不需要因本轮失败直接扩写正文。当前阻断来自 eval：一个 required behavior oracle 缺少必要前提，并把符合生产规则的前置问题判为失败。完整 Codex eval 同时观察到少量 near-miss 误加载和一次确认遗漏；这些是有限的 P2 可靠性问题，尚不足以证明需要立即修改生产 `SKILL.md`。

**下一步：**

执行 `A-01`，先修正并重新裁决 required behavior oracle，再重跑完整 required eval。

## 必须处理

### `F-001` Required behavior oracle 与生产规则冲突 — P1

**为什么重要：**

`natural-access-frontier` 是 required release case。它没有给出产品目标，却要求第一轮必须直接选择目标用户。生产 Skill 明确允许在当前节点缺少必要前提时先补前置问题。当前 Codex trace 正是先问“谁在什么场景解决什么问题”，结果被机械判为失败。这会阻断有效版本，并可能驱动错误的生产修改。

**证据：**

- `plugins/ask-me/skills/decision-grill/SKILL.md:29`
- `plugins/ask-me/skills/decision-grill/evals/decision-grill-release-evals.json:17-43`
- 批次 `20260814T163752Z-full-review-20260815-859437db` 的 `natural-access-frontier` trace
- 完整 admission 记录见 Appendix D 的 `F-001`

**建议：**

在 case 中补充已知产品目标或明确要求目标用户是首个节点，或放宽 oracle 以接受必要的目标前提。同步修正 diagnostic `avoid-exhaustion`：最终记录确认是生产规则要求的步骤，不能当作低影响追问。

**完成标准：**

修订后的 case 通过 strict validator；人工裁决与 `SKILL.md:29`、`:41` 一致；完整 required behavior、固定 trigger/router validation/sanity 和相关 diagnostic case 重跑后，不再由错误 oracle 造成失败。

## 高价值改进

1. **`F-002` 近似负例仍有低频误加载：** 114 次 required negative trigger/router 重复中有 6 次加载 `decision-grill`。先做 paired description ablation 或 previous-version 对照；只有证明确由 description 引起时才改生产文本。
2. **`F-003` 最终确认有一次遗漏：** `shared-understanding-confirmation` 没有调用问题工具，但 required `natural-owner-choice` 和 diagnostic `reopen-on-correction` 均正确执行确认。先增加同族重复运行，不要立即复制或扩写确认规则。

## 已经可靠的部分

- Source 和 project/user materialized Skill 均通过 inspector；插件 validator 通过，Codex project deterministic tests 为 `7/7`。
- required 正例发现稳定：单 Skill trigger 和双 Skill router 的 `decision-grill` positive recall 均为 `100%`，没有漏触发。
- `natural-owner-choice`、`natural-deferred-risk`、`low-prompt-frontier` 和 `reopen-on-correction` 的 current trace 正确处理事实、用户所有的取舍、依赖前沿、延后风险和确认交接。

## 发布限制

| Gate | 状态 | 对发布的影响 | Action ID |
| --- | --- | --- | --- |
| `release-evidence` | fail | required target 虽覆盖 `7/7`，但 `releaseOutcome=failed`，且 required behavior 失败含无效 oracle。 | `A-01` |
| `eval-validity` | fail | 当前 suite 不能驱动生产 Skill 修改或支持 ready 结论。 | `A-01` |

## 质量概览

| 领域 | 状态 | 说明 |
| --- | --- | --- |
| 触发与范围 | adequate | 范围清楚，正例召回稳定；near-miss specificity 为 `94–96%`，严格门禁失败。 |
| 指令、控制与架构 | strong | 流程短、职责正确、状态机风险低；有一次确认遗漏。 |
| 资源、脚本与披露 | strong | 自包含，无不必要 agent-facing script 或外部 reference。 |
| Eval 与发布证据 | weak | corpus 丰富且全量执行，但 required oracle 缺陷使当前 release evidence 不可信。 |

## 行动路线

### 现在

1. **`A-01`：** 修复并重新裁决 `F-001`，然后重跑完整 required eval；在此之前不修改生产 `SKILL.md`。

### 下一步

1. **`A-02`：** 对 `F-002` 做 paired description ablation 或 previous-version 对照，并保留固定 validation/sanity 与相邻 Skill 路由。
2. **`A-03`：** 对 `F-003` 的确认同族增加重复运行；仅在稳定复现时调整完成边界。

### 暂不处理

1. **`A-04`：** `U-001`、`U-002` 的完整价值基线和控制 ablation 不阻断本轮 eval 修复，可在下一次设计迭代中补充。
2. **`A-05`：** `U-003` 的 Claude 模型行为证据不在本次真实模型覆盖范围内，不用 Codex 结果外推。

## 停止与重新打开条件

**现在停止，因为：**

主要失败已经归因为 eval oracle、低频 trigger 方差或有限确认方差。继续给生产正文增加规则会提高上下文和回归风险，且没有 P1 级 Skill defect 证据。

**仅在出现以下情况时重新打开：**

- 修正 oracle 后仍稳定复现同一生产行为失败；
- paired trigger 对照证明 description 是误加载根因；
- 确认同族在多次运行中重复漏掉完成门禁；
- 新的 observed failure、normative requirement 或 structural contradiction。

# `decision-grill` 评审技术附录

## Appendix A — 评审范围与合同

| 项目 | 从材料提取的结论 | 状态 | Evidence |
| --- | --- | --- | --- |
| 目标问题 | 通过逐轮访谈收敛计划、决定或想法，并形成用户确认的共享理解。 | known | `SKILL.md:3,8-12` |
| 已观察失败 | 一次性 runner 说明为历史 observed near-miss；本轮观察到 6 次 negative 误加载和一次确认遗漏。 | known | trigger/router trace；`shared-understanding-confirmation` |
| 成功标准 | 不重问事实；只把用户所有的取舍交给用户；按依赖前沿推进；保留待验证、延后和未解决；确认后交接。 | known | `SKILL.md:16-43` |
| 目标环境或客户端 | AW 插件的 Codex project runtime；user profile 只提供 materialization evidence。 | known | manifest profiles；EvaluationBundle |
| 范围外事项 | 一次性说明/比较/推荐/评审、agent 内部规划、仅需局部实施澄清、确认前实施。 | known | `SKILL.md:3,10-12,43` |
| 相邻 Skill | `requirements-clarifier` 处理具体实施中的关键局部歧义。 | known | 两个 Skill 的 description；router corpus |
| 发布要求 | full 模式；完整 required eval；正式 publish 已授权；README 登记未授权。 | known | 用户授权；manifest；skill-review 合同 |

构建和来源身份：

- Source Git head：`58537006e874103237fdc020148c40377fa33879`
- Source digest：`sha256:41bf1612dee2503a1c10159f20cfd8504c8cc602dd2bb37edeb14ee3d54807c8`
- Source `inScopeDirty=false`
- Build generation：`03a90b75-136d-4ad1-ae59-eb3359fd1326`
- Build output digest：`fbd39762374d96ba1ec6f4c41f442fbc9910adc6ebe4e9ba5d0dbc73d3dc800f`
- CLI package digest：`1df2d68ebf16451b30c12ae490f2fc254f6e47c0a21bb87ca50067e47aba215f`
- Build runtime：Node `v24.14.1`、pnpm `10.33.0`、darwin arm64

## Appendix B — 完整发布门禁

| Gate ID | 状态 | 严重性 | Finding / Unknown IDs | Evidence | 原因 |
| --- | --- | --- | --- | --- | --- |
| `package-validity` | pass | P0 | — | inspector、plugin validator、两类 materialization | 源码和最终制品有效。 |
| `critical-artifacts` | pass | P0 | — | manifest、fixture、4 份 executable corpus | 必需材料存在且可解析。 |
| `goal-alignment` | pass | P0 | — | `SKILL.md:8-43` | 核心程序与协作决策目标一致。 |
| `capability-validity` | pass | P0 | — | Codex materialized `request_user_input`；7/7 plugin tests | 核心交互能力可用。 |
| `safety-permissions` | pass | P0 | — | managed process；workspace diff 为空 | 没有静默副作用或越权证据。 |
| `architecture-ownership` | pass | P1 | — | state-machine risk low；无跨 role 协议 | Skill 只维护稳定策略。 |
| `release-evidence` | fail | P1 | `F-001` | required `7/7`；`releaseOutcome=failed` | required behavior 失败含无效 oracle，当前证据不能支持发布。 |
| `eval-validity` | fail | P1 | `F-001` | required 和 diagnostic oracle 复核 | 高置信 oracle 与生产规则不相容。 |
| `eval-change-safety` | not_applicable | P1 | — | 本轮未修改生产 Skill | 没有 eval-driven change。 |

## Appendix C — Full Scorecard

| 维度 | 权重 | 分数 | 置信度 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- |
| 规范与包完整性 | 6 | 5 | high | — | — | 源码和两类 materialized package 有效。 |
| 问题基础与实际价值 | 8 | 4 | medium | — | `U-001` | 有行为增量，但缺 previous/minimal baseline。 |
| 调用策略、触发条件与 Context Pointer | 10 | 3.5 | high | `F-002` | — | recall 稳定，specificity 有低频缺口。 |
| 范围、边界与组合性 | 8 | 5 | high | — | — | 与直接回答和 requirements clarification 的边界清楚。 |
| 程序与完成边界 | 10 | 4 | high | `F-003` | — | 程序清楚，但一次确认遗漏。 |
| 最小充分控制与模型自由度 | 14 | 4 | medium | — | `U-002` | 控制适当，但无 ablation。 |
| 信息层级、资源与渐进式披露 | 10 | 5 | high | — | — | 自包含且无资源 sprawl。 |
| 职责归属与自然语言状态机风险 | 10 | 5 | high | — | — | runtime 和 Skill 职责分层正确。 |
| 脚本与确定性自动化 | 7 | 5 | high | — | — | agent-facing script 正确省略。 |
| Eval 设计、Oracle 有效性与修改安全 | 9 | 2.5 | high | `F-001` | — | suite 丰富，但 required oracle 无效。 |
| 可靠性、安全与兼容性 | 4 | 3 | high | — | `U-003` | Codex 安全证据充分；Claude 行为未验证。 |
| 剪枝、事实源与变更纪律 | 4 | 5 | high | — | — | 正文短，release/diagnostic corpus 分离。 |

- **加权总分：** 84.5 / 100
- **原始质量带：** strong
- **有效质量带：** strong
- **复杂度上限原因：** 无；复杂度为 `proportionate`，reducibility 为 `minor`。

## Appendix D — Finding Admission Records

### `F-001`

- **Location：** `plugins/ask-me/skills/decision-grill/evals/decision-grill-release-evals.json:11-43`
- **Exact claim：** required `natural-access-frontier` 无条件要求先问目标用户，但 prompt 没有建立产品目标这一必要前提，且被引用的生产规则允许先补必要前提；current trace 因执行该例外而被机械判失败。
- **Affected scenario：** 默认完整发布 eval 使用该 case 判断 Skill 是否可发布或是否需要修改。
- **Material impact：** 无效 oracle 直接使 required behavior 和 release outcome 失败，并可能推动错误生产修改。
- **Direct evidence：** `SKILL.md:29`；release case `:17-43`；current trace；batch required target summary。
- **Counterevidence：** without-owner baseline 按 oracle 提问，但没有解决缺失前提；`low-prompt-frontier` 在输入明确候选和链路时通过；两个其它 required behavior case 通过定性复核。
- **Owner：** Eval
- **Minimal action：** 补充已知产品目标或明确首个节点，或允许必要前提；同步修正 `avoid-exhaustion` 的确认 oracle。
- **Validation：** strict validator；人工 rule trace；完整 required behavior 与相关 diagnostic 重跑。

| Premise | Source role | Evidence | Status |
| --- | --- | --- | --- |
| case 进入 release evidence | Project eval contract | manifest 的 behavior `requiredForRelease=true` | supported |
| 产品目标不是已知前提 | Case fixture | `existing_decisions=false`；prompt 只给“合作产品” | supported |
| 生产规则允许必要前提 | Production Skill | `SKILL.md:29` 的明确例外 | supported |
| current 因前提问题偏离 scripted path | Observed trace | 问“谁在什么场景解决什么问题”；2 个 reply 未使用 | supported |

| Reachability kind | Path | Evidence | Status |
| --- | --- | --- | --- |
| execution-path | manifest behavior → release corpus → `natural-access-frontier` → scripted reply gate | 完整批次 required covered `7/7`，behavior target failed | supported |

`F-002` 和 `F-003` 为 P2，完整结构化字段保存在 scorecard JSON。二者不进入 P0/P1 admission gate。

## Appendix E — 适用专项审计

### Invocation / Context Pointer Audit

| Pointer | 目标材料 | 触发 branch | 意图前置 | 重复 branch | 重复正文身份 | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| frontmatter description | 完整 `SKILL.md` | 明确逐轮共同推演或外层进入该阶段 | 是 | 否 | 少量必要重复 | required trigger recall `100%`；negative specificity `95.8%` | 先做 paired ablation，再决定是否改 description。 |
| `agents/openai.yaml` default prompt | 显式用户调用 | 用户输入 `$decision-grill` | 是 | 否 | 否 | explicit trigger/router 均 `10/10` 或 `3/3` | 保留。 |
| 正文中的 `requirements-clarifier` | 相邻 Skill | 具体实施只缺局部关键歧义 | 是 | 否 | 否 | router 相邻路径多数正确，偶有同时加载 | 保留 branch；不复制相邻正文。 |

### Minimum Effective Control Audit

#### 最小行为合同

1. 仅在明确需要逐轮共同推演时进入；一次性回答、内部规划和局部实施澄清不进入。
2. 先查清事实和已有决定；可查事实不问用户。
3. 用户承担后果的决定交给用户；技术事实和待验证事项分开。
4. 只推进已具备前提的当前前沿；依赖不明时每轮一题，明确独立时最多三题。
5. 不无依据推荐，不重开充分决定，不穷举低影响细节。
6. 重要分支决定、委托、待验证或明确延后后停止，并保留责任、期限、条件和风险。
7. 最终记录需确认或明确跳过；确认前不修改、原型或实施。

#### 控制面

| Signal | Count / observation | Risk |
| --- | ---: | --- |
| Mandatory stages | 3：建树、推进、收尾 | low |
| Hard gates | 1：最终记录确认 | low；可由用户跳过 |
| Fixed intermediate artifacts | 0 | low |
| Prohibitions | 事实不问用户、不得代答、确认前不实施等 4 个行为不变量 | low |
| Conditional branches | inspector 计数 6 | low |
| Fixed output fields | 0；记录字段按需省略 | low |

#### 必要性映射与简化候选

| 当前行为块 | 改变的行为 | 依据 | 当前控制类型 | 模型默认能否处理 | 处理建议 | 删除或放宽风险 |
| --- | --- | --- | --- | ---: | --- | --- |
| 触发与非目标 | 防止直接任务变成长访谈 | 高 FN/FP 代价；trigger corpus | invariant | 否 | keep-invariant | 误触发或漏掉用户要求的访谈。 |
| 事实先查 | 防止把可查事实交给用户 | behavior corpus | default | 部分 | keep-default | 增加用户负担，重问已知事实。 |
| 用户所有的取舍 | 防止 agent 代替用户承担后果 | required behavior | invariant | 否 | keep-invariant | 把 agent 偏好写成用户决定。 |
| 当前前沿与每轮题数 | 防止询问无效下游和问题堆叠 | frontier cases | default/invariant | 部分 | keep-default | 产生依赖无效问题。 |
| 不重开/不穷举 | 控制访谈长度 | diagnostic behavior | default | 部分 | keep-default | 访谈进入低影响细节。 |
| 决策记录 | 防止丢失委托、验证和风险 | record cases | invariant | 部分 | keep-invariant | 交接信息丢失。 |
| 最终确认和确认前只读 | 确认共享理解并阻止提前实施 | required/diagnostic completion cases | invariant | 否 | keep-invariant | 未确认记录被当成最终决定。 |
| 三层章节组织 | 提高可读性，无额外行为 | heuristic | 是 | needs-ablation | 可能只影响导航；无行为证据支持继续拆分。 |

复杂度结论：`proportionate`。生产正文只有 40 行、约 762 tokens；没有固定中间 artifact、完整 runbook 或自然语言状态表。可选简化只涉及章节和少量重复边界，reducibility 为 `minor`。

### Information Hierarchy Map

| 内容 | 类型 | 适用 branch | 当前位置 | 每次需要 | Pointer 或环境事实源 | 最小控制结论 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| 触发和相邻边界 | in-file-reference | 每次激活前 | description、导言 | 是 | Skill catalog | keep-invariant | 保留。 |
| 只读事实核对 | in-file-step | 建树 | `建立决策树` | 是 | 对话、代码、文档 | keep-default | 保留为默认。 |
| 决定/事实/验证分类 | in-file-reference | 建树 | `建立决策树` | 是 | 当前对话与领域证据 | keep-invariant | 保留。 |
| 当前前沿 | in-file-step | 逐轮交互 | `推进当前前沿` | 是 | 用户给出的依赖链 | keep-default | 保留。 |
| 问题工具 schema | environment-lookup | 适合列选项时 | runtime tool | 否 | `request_user_input` schema | keep-default | 不复制 schema。 |
| 决策记录与确认 | in-file-step | 收尾 | `收尾` | 是 | 当前对话状态 | keep-invariant | 保留。 |
| Eval corpus | disclosed-reference | 作者验证 | `evals/manifest.json` | 否 | manifest suite pointer | 不属于 runtime 控制 | 继续与 runtime package 分离。 |

### Completion Boundary Audit

| 步骤或规则集 | 当前标准 | 清楚 | 可检查 | 要求充分 | 覆盖完整 | 提前完成风险 | 建议 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 事实核对 | 已查看对话、决定和相关代码/文档；可查事实不再作为用户问题 | 是 | 是 | 是 | 是 | 低 | 保留。 |
| 当前前沿 | 只问前提已明确的最上游决定；回答后重算 | 是 | 是 | 是 | 是 | 中 | 保留；`natural-access` oracle 必须尊重必要前提例外。 |
| 停止 | 重要分支均决定、委托、待验证或明确延后并接受风险 | 是 | 是 | 是 | 是 | 低 | 保留。 |
| 决策记录 | 只输出非空类别；委托含责任人、期限、条件 | 是 | 是 | 是 | 是 | 低 | 保留。 |
| 确认与交接 | 用户确认或明确跳过后交还原工作流 | 是 | 是 | 是 | 是 | 中 | 收集 `F-003` 同族重复。 |
| 确认前只读 | diff 为空，无原型或实施 | 是 | 是 | 是 | 是 | 低 | 保留。 |

### Architecture and Ownership

- **Skill 负责的策略：** 触发边界、事实与决定分层、当前前沿、问题批量默认、停止、记录和确认不变量。
- **Schema 或客户端负责的事实：** 问题字段、选项结构、tool availability、materialized tool name。
- **Runtime 负责的状态：** 当前轮次、问题等待、回答、取消、交接和实际 workspace 状态。
- **脚本候选：** 无；访谈取舍不是确定性转换。
- **仅属于 role 的约束：** 无独立 role。
- **仅属于 eval 或 issue 的问题：** 低概率误加载、oracle 边界和 confirmation 方差。
- **自然语言状态机风险：** low

### Scripts and Resources

- **已有脚本或正确省略：** production Skill 无 agent-facing script，正确省略。
- **接口、依赖和安全质量：** eval wrapper 仅 re-export；被导入 fixture 只有 `node:fs/promises`、`node:path`，写入仅在显式 setup 调用中发生。
- **模型仍在重复的确定性逻辑：** 无需脚本化的重复逻辑。
- **Reference 和 asset 可达性：** runtime 不需要 reference/asset；eval 由 manifest 一层到达。
- **重复、scattering 与 co-location：** 核心规则均在一个 `SKILL.md`；相邻边界在 description 和导言有少量必要重复。
- **不必要缓存的环境事实：** 无。
- **过期或孤立资源：** inspector 未发现。

### Eval Case Audit

#### 目标和错误代价

| 项目 | 判定 | 证据 |
| --- | --- | --- |
| Optimization policy | balanced | 4 份 executable corpus 均明确声明。 |
| False-negative cost | high | 漏掉访谈可能替用户作出重要决定。 |
| False-positive cost | high | 误入访谈会把直接任务变成长流程。 |
| Policy rationale | 两类错误均会改变工作流，不能用总体 accuracy 掩盖。 | corpus policy；router `forbidMultipleSkillLoads` |

#### Eval 门禁

| Gate | 状态 | 证据 | 原因 |
| --- | --- | --- | --- |
| `eval-validity` | fail | `F-001`；`avoid-exhaustion` trace | required 和 diagnostic 高置信 oracle 与生产例外/确认规则冲突。 |
| `release-evidence` | fail | required covered `7/7`；releaseOutcome `failed` | 当前 complete evidence 不能支持 ready。 |
| `eval-change-safety` | not_applicable | 无生产修改 | 本轮不接受 eval-driven Skill change。 |

#### Suite 构成

| 指标 | 数量或判定 |
| --- | ---: |
| Cases | 57 |
| Scenario families | 35 |
| Decision boundaries / minimal pairs | 28 个显式 minimal counterexample |
| Representative cases | 14 |
| Regression cases | 1 |
| Boundary cases | 27 |
| Challenge cases | 0 |
| Diagnostic-only cases | 15 |
| Stale / ambiguous cases | 0 stale；2 个 oracle 需修正 |

4 个 manifest-referenced case 文档均通过 compatible validator。3 个 required 文档共 42 cases 也通过 strict validator。Validator 只证明结构有效；`F-001` 是语义问题。

#### Case Admission 结果

| Case | 层级 | Role | Provenance | Oracle 置信度 | 前提充分 | Rule trace | 现实 | 决策 |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| `decision-grill-trigger-cases.json` 的 25 cases | trigger | representative / boundary | observed / derived / synthetic / boundary | high | 是 | 是 | 是 | release-counted |
| `ask-me-routing-cases.json` 的 14 cases | routing | representative / regression / boundary | observed / derived / boundary | high | 是 | 是 | 是 | release-counted |
| `natural-owner-choice` | behavior | representative | derived | high | 是 | 是 | 是 | release-counted |
| `natural-deferred-risk` | behavior | representative | derived | high | 是 | 是 | 是 | release-counted |
| `natural-access-frontier` | behavior | representative | derived | 声明 high，裁决为 low | 否 | 否 | 部分 | needs-adjudication |
| `decision-grill-evals.json` 的 15 cases | behavior | diagnostic | mechanism-probe / derived | high | 除 `avoid-exhaustion` 外是 | 除 `avoid-exhaustion` 外是 | 诊断级 | diagnostic-only |

#### Trigger 或其它二元决策结果

| 指标 | 当前结果 | Baseline / previous | 解释 |
| --- | ---: | ---: | --- |
| Standalone positive recall | 100% (`21/21`) | 无 | 没有漏触发。 |
| Standalone false-negative rate | 0% | 无 | — |
| Standalone negative specificity | 95.8% (`23/24`) | 无 | `n03_one_shot_plan_review` 一次误加载。 |
| Standalone false-positive rate | 4.2% | 无 | validation 的严格负例零容忍，因此 target fail。 |
| Router decision-grill positive recall | 100% (`50/50`) | 无 | 所有目标访谈都只或至少加载 owner。 |
| Router decision-grill false-negative rate | 0% | 无 | — |
| Router decision-grill negative specificity | 94.4% (`85/90`) | 无 | 5 次 owner 误加载，3 次同时加载两个 Skill。 |
| Router decision-grill false-positive rate | 5.6% | 无 | sanity exact route `54/60`，validation `79/80`。 |
| Mixed / uncertain cases | 6 个 negative case 各出现 1 次 owner load | 无 | 归因 `model-variance`，需 paired ablation。 |

#### Behavior、outcome 和 cost 证据

| Scenario family | With Skill | Baseline | Quality delta | Token/time delta | 方差 | 证据强度 |
| --- | --- | --- | ---: | ---: | --- | --- |
| dependent-decision-frontier (`natural-access`) | 先补产品目标前提；机械 fail | 直接问目标用户；机械 pass | oracle 不可比较 | `+1,519` tokens；`-9.2s` | 1 run | low：oracle invalid |
| user-owned-tradeoff | 读取事实、只让用户选优先级、确认后交接 | 给建议但未进入确认 | 明显正向 | `+36,330` tokens；`+7.4s` | 1 run | medium |
| explicit-deferral | 一轮后记录延后和风险 | 多问一轮后停止 | 正向 | `-8,726` tokens；`-7.2s` | 1 run | medium |
| low-prompt-frontier diagnostic | 两轮正确前沿并交接 | 没有调用问题工具，scripted replies 未使用 | 正向 | diagnostic 未进入 release cost | 1 run | diagnostic |

#### Failure triage

| Case / assertion | Failure class | 可复现 | Root owner | 动作 | 理由 |
| --- | --- | ---: | --- | --- | --- |
| `natural-access-frontier` | oracle-defect | 是 | Eval | fix-eval-first | 缺产品目标前提，生产规则允许必要前置问题。 |
| `n03_one_shot_plan_review` | model-variance | 否，`1/3` | 未证明 | collect-more-data | description 已明确排除一次性评审。 |
| `approved_plan_implementation_gap` | model-variance | 否，`1/10` | 未证明 | collect-more-data | 其余 `9/10` 精确路由 requirements-clarifier。 |
| `export_convention` | model-variance | 混合 | 未证明；包含相邻 Skill | paired ablation | owner load `1/10`；整体 exact route `7/10`。 |
| `export_override_convention` | model-variance | 否，`1/10` owner 误加载 | 未证明 | collect-more-data | requirements-clarifier 为 `10/10`，一次同时加载。 |
| required `natural-owner-choice` | none | 是 | — | accept | current 满足 4 项 qualitative checks。 |
| required `natural-deferred-risk` | none | 是 | — | accept | current 满足 3 项 qualitative checks。 |
| diagnostic `avoid-exhaustion` | oracle-defect | 是 | Eval | fix-eval-first | 第二题是 `SKILL.md:41` 要求的确认，不是低影响细节。 |
| diagnostic `shared-understanding-confirmation` | insufficient-runs | 否，1 run；同族有 pass | 未证明 | collect-more-data | current 漏确认；required owner-choice 和 correction case 通过。 |
| 其余 13 个 diagnostic `needs_review` | none | 1 run | — | diagnostic-only | current trace 均满足对应 qualitative checks。 |

#### Eval-driven 修改决策

- **修改内容：** 无生产修改。
- **受影响场景族：** dependent frontier、near-miss routing、final confirmation。
- **为什么是 Skill defect：** 当前没有 P1 级 Skill defect；`F-002`、`F-003` 仅为有限 observed gaps。
- **原始失败证据：** 完整 required run 和补充 diagnostic trace。
- **Minimal pair / 相反标签风险：** description 改动可能降低 `100%` positive recall 或破坏 requirements-clarifier 路由。
- **Validation、sanity 和 regression 重跑：** 未做生产修改，因此不接受 change gate。
- **Quality delta：** 不适用。
- **Context / branch / maintenance delta：** 0；没有修改生产正文。
- **决策：** fix-eval-first

#### Eval 维度

- **分数：** 2.5 / 5
- **置信度：** high
- **适用评分上限：** 已知错误 oracle 进入 required release evidence，因此不能评为可靠迭代级。
- **摘要：** case 结构、错误代价、现实边界、重复运行和 baseline 均较完整，但 required oracle 缺陷使 `eval-validity` 和 `release-evidence` 失败。

#### 停止决定

先修 eval 并重新裁决；不要由当前失败驱动生产 Skill 扩写。修正后只在固定 complete required set 上重新判断发布结论。diagnostic suite 仅用于归因，不进入 release 指标。

## Appendix F — 执行记录和限制

### 完整模型批次

- Batch ID：`20260814T163752Z-full-review-20260815-859437db`
- Required target：`7/7` covered
- Release outcome：`failed`
- Required target passed：project materialization、user materialization、trigger sanity
- Required target failed：behavior all、router validation、router sanity、trigger validation
- Required failed cases：`natural-access-frontier`、`n03_one_shot_plan_review`、`approved_plan_implementation_gap`、`export_convention`、`export_override_convention`
- Required raw `needs_review`：`natural-owner-choice`、`natural-deferred-risk`；人工定性复核均通过
- Diagnostic run：完整 15 cases；因显式 suite 过滤，run-level `incomplete`，不进入 release target；13 个 `needs_review` 已逐项复核，2 个机械失败已归因

### 运行命令和退出状态

| 命令 | 退出状态 | 说明 |
| --- | ---: | --- |
| `pnpm build` | 0 | 共享构建证据；构建身份见 Appendix A。 |
| `node .agents/skills/create-aw-plugin/scripts/validate_plugin.mjs plugins/ask-me --json` | 0 | `ok=true`；仅有 production bundle unchanged warning，不是 Skill finding。 |
| `pnpm plugin:test ask-me --platform codex --scope project` | 0 | 7/7 tests pass。 |
| `node .agents/skills/skill-review/scripts/inspect_skill_target.mjs plugins/ask-me --format json` | 0 | 无 issue。 |
| `validate_eval_cases.mjs <4 manifest case docs> --format json` | 0 | 4/4 compatible valid。 |
| `validate_eval_cases.mjs <3 required case docs> --strict --format json` | 0 | 3/3 strict valid。 |
| `pnpm plugin:eval ask-me --skill decision-grill --batch-name full-review-20260815` | 1 | 完整 required run；complete，covered `7/7`，releaseOutcome failed。 |
| `inspect_skill_target.mjs plugins/ask-me --evaluation <required raw/evaluation.json> --format json` | 0 | 报告 evaluation failed 和 qualitative-review warning。 |
| `pnpm plugin:eval ask-me --skill decision-grill --batch-id <batch-id> --suite behavior-diagnostic` | 1 | 完整 diagnostic suite；显式 subset 使 run-level incomplete，case `15/15` complete。 |

### 环境和证据限制

- 真实模型证据仅覆盖 Codex `gpt-5.6-luna`，Codex CLI `0.147.0`，provider `openai-oauth`。
- Process management 为 `managed`，`descendantCleanupGuaranteed=true`；未使用 `--allow-unmanaged-processes`。
- user-default 只有 materialization evidence，没有 Codex native user-cache 模型运行。
- Behavior current/baseline 每个 case 只有 1 次；混合 trigger case 虽已有 3 或 10 次重复，仍缺 previous-version 或 paired ablation。
- 本次是 full 模式，不是 release 模式；没有核对 current-check 官方来源。
- 正式 publish 已授权；README 登记未授权，因此不会运行 `review:release`，也不会修改 README、Skill 或 plugin source。
