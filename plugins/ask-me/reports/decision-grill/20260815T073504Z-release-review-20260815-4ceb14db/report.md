# `decision-grill` 评审

## 结论

- **设计结论：** needs-fixes
- **发布就绪度：** blocked
- **复杂度：** proportionate
- **证据：** coverage `100%`；confidence `high`

**判断：**

生产 Skill 的目标、职责、控制强度和架构仍然合理，不需要根据本轮失败直接扩写正文。当前 Codex release batch 已完整覆盖 required target，但双 Skill router 在非目标场景重复读取 `decision-grill`，违反项目的精确路由发布合同。required behavior 还观察到一次当前前沿偏离；该偏差只有一个样本，定为 P2。

**下一步：**

执行 `A-01`：先用 paired rerun 和 description/metadata ablation 隔离 `DG-F-001` 的根因，再由证据选择 Skill、客户端或路由层动作。

## 必须处理

### `DG-F-001` Codex 双 Skill 精确路由未达到发布合同 — P1

**为什么重要：**

完整 required batch 中，`export_clarify` 有 `1/10` 同时加载两个 Skill，`runner_recommend` 有 `2/10` 同时加载两个 Skill。router validation 和 sanity 都因此失败，最终 `releaseOutcome=failed`。这会增加不相关上下文，并可能把直接回答或局部实施澄清变成决策访谈。

**证据：**

- `plugins/ask-me/skills/decision-grill/evals/manifest.json#suites/router`
- batch `20260815T073504Z-release-review-20260815-4ceb14db` 的 router validation/sanity reports
- 完整 admission 记录见 Appendix D 的 `DG-F-001`

**建议：**

先对 `export_clarify`、`runner_recommend` 和 `plan_review` 做固定 Codex paired rerun，并分别测试 description/metadata 组合。失败 trace 在读取两个 Skill 前已用自然语言判断出正确交付类型，因此当前证据没有证明 production `SKILL.md` 是根因。

**完成标准：**

新的无过滤完整 release batch 达到 `7/7` complete，router validation/sanity 均通过；decision-grill 正例召回、requirements-clarifier 精确路由、validation、sanity 和 regression 不回归。

## 高价值改进

1. **`DG-F-002` 明确依赖链后插入额外前沿：** `natural-access-frontier` 正确完成目标用户和访问边界两轮，但把“邀请/识别外部伙伴”设为下一项，而不是按输入链路列出权限和计费。先增加同族重复运行；只有稳定复现时才收紧现有前沿规则。

## 已经可靠的部分

- Source 与 Codex project/user materialized Skill 均通过 inspector；插件 validator 通过，Codex project deterministic tests 为 `7/7`。
- 单 Skill trigger 正例 `21/21`、负例 `24/24`；双 Skill router 的 decision-grill 正例 `50/50`，没有漏触发。
- `natural-owner-choice` 正确读取文档事实、只让用户决定优先级、确认记录后交接；`natural-deferred-risk` 正确保留延后状态和上市风险。

## 决策关键的证据缺口

| ID | 缺少的证据 | 当前影响 | 获得方式 |
| --- | --- | --- | --- |
| `DG-U-003` | failed router 和 `natural-access-frontier` 的 paired 重复及 previous/description ablation | 不改变当前 blocked，但决定根因 owner 和最小修复位置 | 固定当前 case、模型、profile 和 isolation 做 paired run；比较 route、trace、token 和时间 |

## 发布限制

| Gate | 状态 | 对发布的影响 | Action ID |
| --- | --- | --- | --- |
| `release-evidence` | fail | required target 虽覆盖 `7/7`，但 router validation/sanity 失败，`releaseOutcome=failed`。 | `A-01` |

安全执行证据：

- `pnpm build` 成功；插件 validator 为 `ok=true`；Codex project plugin tests `7/7` 通过。
- inspector 对源码无 issue；对失败 EvaluationBundle 正确报告 `evaluation.failed` 和 qualitative review warning。
- required 三份 case 文档 strict-valid；diagnostic 文档 compatible-valid。
- 完整 eval 使用 managed process，`descendantCleanupGuaranteed=true`，未使用 `--allow-unmanaged-processes`。

## 质量概览

| 领域 | 状态 | 说明 |
| --- | --- | --- |
| 触发与范围 | adequate | 单 Skill trigger 稳定；router exact route 为 `135/140`，但多 Skill 读取触发发布门禁。 |
| 指令、控制与架构 | strong | 正文短、职责正确、状态机风险低；一个 behavior trace 偏离明确下一前沿。 |
| 资源、脚本与披露 | strong | runtime 自包含；agent-facing script 正确省略；作者 fixture 和 test 安全边界清楚。 |
| Eval 与发布证据 | adequate | oracle、baseline 和 trace 可用；完整结果为 failed，behavior 方差和 root cause 仍需 paired 证据。 |

## 行动路线

### 现在

1. **`A-01`：** 对 `DG-F-001` 做 paired rerun 和 description/metadata ablation；根因确认前不扩写 production Skill。

### 下一步

1. **`A-02`：** 为 `DG-F-002` 增加同族 behavior repetitions；只有重复出现时才调整当前前沿完成边界。
2. **`A-03`：** 若要声明 Claude 行为等价，补充 `DG-U-004` 的 Claude 模型 trace；本报告不能从 Codex 外推。

### 暂不处理

1. **`A-04`：** `DG-U-001` 和 `DG-U-002` 的 minimal/previous ablation 不阻断当前根因定位；没有新失败证据时不做文字剪枝。

## 停止与重新打开条件

**现在停止，因为：**

完整 release evidence 已取得，当前发布阻断已定位到少量 Codex 精确路由失败。继续添加自然语言规则不能证明会修复 client/model 加载行为，并会增加正例召回和相邻路由回归风险。

**仅在出现以下情况时重新打开：**

- paired trace 证明 production description 或 metadata 是双加载根因；
- `natural-access-frontier` 同族重复稳定偏离明确依赖链；
- 新的 observed failure、normative requirement 或 structural contradiction；
- 固定完整 eval 集出现新的稳定回归。

# `decision-grill` 评审技术附录

## Appendix A — 评审范围与合同

| 项目 | 从材料提取的结论 | 状态 | Evidence |
| --- | --- | --- | --- |
| 目标问题 | 通过逐轮访谈收敛计划、决定或想法，并形成用户确认的共享理解。 | known | `SKILL.md:6-12` |
| 已观察失败 | 历史 runner 说明 near-miss；本轮 4/90 非目标 router repetitions 加载 owner，另有一次下一前沿偏离。 | known | trigger/router/behavior current traces |
| 成功标准 | 不重问事实；只把用户所有的取舍交给用户；按依赖前沿推进；保留待验证、延后和未解决；确认后交接。 | known | `SKILL.md:14-43` |
| 目标环境或客户端 | AW 插件的 Codex project runtime；user profile 只提供 materialization evidence。 | known | manifest profiles；EvaluationBundle |
| 范围外事项 | 一次性说明、比较、推荐或评审；agent 内部规划；仅需局部实施澄清；确认前实施。 | known | frontmatter；`SKILL.md:8-12,43` |
| 相邻 Skill | `requirements-clarifier` 处理具体实施中的关键局部歧义。 | known | 两个 Skill 的 description；router corpus |
| 发布要求 | release 模式；默认完整 required eval；正式 publish 已授权；README 登记未授权。 | known | 用户授权；manifest；skill-review 合同 |

源码和运行身份：

- Batch ID：`20260815T073504Z-release-review-20260815-4ceb14db`
- Source Git head：`154923cee33855db69cdee66444b07638551e14f`
- Source digest：`sha256:22cbb01de4520be97bc81c9328c1215c987bd945fd5af6e97889b30eaff63bdf`
- Source `inScopeDirty=false`
- Codex CLI：`0.147.0`
- Model：`gpt-5.6-luna`
- Provider：`openai-oauth`
- Project config digest：`sha256:e615b1f809e169fad34b9f0a401be7516b9ffec3acfadab9c6e8be469b7204ed`
- Bundle digest：`sha256:0fbee78549cd05dda6d18f3821344cb7f7f781727d089cc638c2c3d7460fbb33`
- Plugin bundle digest：`sha256:1f86b9330bc48ddeb2ecfa431ab26e9e27414e7eb908d636c9ed30632cf914b1`
- Process management：`managed`；`descendantCleanupGuaranteed=true`

### Current-check 官方来源

以下官方来源已于 `2026-08-15` 重新打开并核验：

- [Agent Skills specification](https://agentskills.io/specification)：目录、frontmatter、渐进式披露和相对引用。
- [Best practices for skill creators](https://agentskills.io/skill-creation/best-practices)：问题基础、范围、控制强度、默认值、procedure 和 validation loop。
- [Optimizing skill descriptions](https://agentskills.io/skill-creation/optimizing-descriptions)：description、现实 near-miss、固定 train/validation 和多次 trigger run。
- [Using scripts in skills](https://agentskills.io/skill-creation/using-scripts)：相对路径、非交互接口、`--help`、错误和结构化输出。
- [Evaluating skill output quality](https://agentskills.io/skill-creation/evaluating-skills)：现实 case、without-skill/previous baseline、assertion、trace、成本和迭代。

第三方写作启发未用于 P0/P1 或发布门禁。

## Appendix B — 完整发布门禁

| Gate ID | 状态 | 严重性 | Finding / Unknown IDs | Evidence | 原因 |
| --- | --- | --- | --- | --- | --- |
| `package-validity` | pass | P0 | — | source/final inspector；plugin validator | 结构、frontmatter、名称和 materialization 有效。 |
| `critical-artifacts` | pass | P0 | — | manifest、4 份 corpus、fixture、metadata | 所有必需引用存在且可解析。 |
| `goal-alignment` | pass | P0 | — | `SKILL.md:6-43` | 核心程序与协作决策目标一致。 |
| `capability-validity` | pass | P0 | — | Codex materialized `request_user_input`；behavior trace | 核心交互能力可用。 |
| `safety-permissions` | pass | P0 | — | strict isolation；workspace unchanged；managed cleanup | 没有越权、宿主源码访问或副作用。 |
| `architecture-ownership` | pass | P1 | — | state-machine risk low；runtime trace | Skill 没有维护高风险生命周期。 |
| `release-evidence` | fail | P1 | `DG-F-001` | required `7/7`；router validation/sanity failed | 当前 Codex 精确路由未达到发布合同。 |
| `eval-validity` | pass | P1 | — | strict/compatible validator；Case Admission；oracle audit | 关键 case 有效；旧缺前提 oracle 已关闭。 |
| `eval-change-safety` | not_applicable | P1 | — | 本轮生产 diff 为 0 | 没有 eval-driven 生产修改。 |

## Appendix C — Full Scorecard

| 维度 | 权重 | 分数 | 置信度 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- |
| 规范与包完整性 | 6 | 5 | high | — | — | source 和最终制品有效。 |
| 问题基础与实际价值 | 8 | 4 | medium | — | `DG-U-001` | baseline 显示增量，但缺 minimal/previous ablation。 |
| 调用策略、触发条件与 Context Pointer | 10 | 3.5 | high | `DG-F-001` | — | 单 Skill 稳定，双 Skill 精确路由未达门禁。 |
| 范围、边界与组合性 | 8 | 5 | high | — | — | 与直接回答和局部澄清边界清楚。 |
| 程序与完成边界 | 10 | 4 | high | `DG-F-002` | — | 程序清楚；一次当前前沿偏离。 |
| 最小充分控制与模型自由度 | 14 | 4 | medium | — | `DG-U-002` | 控制适当，缺正式 ablation。 |
| 信息层级、资源与渐进式披露 | 10 | 5 | high | — | — | 自包含，无资源 sprawl。 |
| 职责归属与自然语言状态机风险 | 10 | 5 | high | — | — | runtime 与 Skill 职责正确。 |
| 脚本与确定性自动化 | 7 | 5 | high | — | — | production script 正确省略；作者脚本安全。 |
| Eval 设计、Oracle 有效性与修改安全 | 9 | 4 | high | — | `DG-U-003` | case 和 oracle 有效，方差与因果证据仍有限。 |
| 可靠性、安全与兼容性 | 4 | 3 | medium | — | `DG-U-004` | Codex 有证据，Claude 行为未验证。 |
| 剪枝、事实源与变更纪律 | 4 | 5 | high | — | — | 正文短，旧 oracle 问题关闭，无规则沉积。 |

- **加权总分：** 87.2 / 100
- **原始质量带：** strong
- **有效质量带：** strong
- **复杂度上限原因：** 无；复杂度为 `proportionate`，reducibility 为 `minor`。

## Appendix D — Finding Admission Records

### `DG-F-001`

- **Location：** `plugins/ask-me/skills/decision-grill/evals/manifest.json#suites/router`；batch router validation/sanity reports
- **Exact claim：** 当前 Codex project runtime 在 90 次 decision-grill 非目标 router repetitions 中加载 owner 4 次，其中 3 次同时加载两个 participant Skill；这使两个 required router targets 和完整 release outcome 失败。
- **Affected scenario：** 一次性 runner 推荐，以及只有局部实施需求歧义的订单导出请求。
- **Material impact：** 当前版本不满足项目发布合同；双加载会增加互斥工作流的上下文和串扰风险。harness 在双加载时终止，因此未声称最终用户输出已失败。
- **Direct evidence：** `export_clarify` route counts `requirements=9 / both=1`；`runner_recommend` `neither=8 / both=2`；batch required `7/7`、release failed。
- **Counterevidence：** standalone trigger `45/45`；router owner positive `50/50`；router exact `135/140`；失败 trace 先口头判断正确交付类型，再读取两个 Skill。
- **Owner：** Client
- **Minimal action：** paired rerun 和 description/metadata ablation；根因确认前不要求 production `SKILL.md` 修改。
- **Validation：** 新的完整 release batch 通过两个 router targets，并保持正例、相邻 Skill 和固定 regression。

| Premise | Source role | Evidence | Status |
| --- | --- | --- | --- |
| router validation/sanity 是 required，且多 Skill 加载零容忍 | Project manifest | `defaultRuns=10`、`forbidMultipleSkillLoads=true`、`requiredForRelease=true` | supported |
| 两个失败 case 的 oracle 与实际交付类型一致 | Eval case | high-confidence rationale、rule refs、minimal counterexample、strict validator | supported |
| 失败不是执行错误或缺 fixture | Runtime / fixture | final repetitions `execution_errors=0`；`export_clarify` 使用 `neutral_export_repo` | supported |
| 双加载重复发生 | Runtime trace | 两个场景、三次 simultaneous load；`runner_recommend` 为 `2/10` | supported |

| Reachability kind | Path | Evidence | Status |
| --- | --- | --- | --- |
| execution-path | manifest router → validation/sanity case → Codex 读取 materialized Skills → multiple-load gate | complete batch；两个 required target failed | supported |

`DG-F-002` 为 P2。完整结构化证据保存在 scorecard JSON。

## Appendix E — 适用专项审计

### Invocation / Context Pointer Audit

| Pointer | 目标材料 | 触发 branch | 意图前置 | 重复 branch | 重复正文身份 | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| frontmatter description | 完整 `SKILL.md` | 用户要求逐轮共同推演，或外层工作流进入该阶段 | 是 | 否 | 少量必要重复 | standalone recall `21/21`；router owner recall `50/50` | 保留；先查 client/model 双加载根因。 |
| `agents/openai.yaml` default prompt | 显式用户调用 | 用户输入 `$decision-grill` | 是 | 否 | 否 | explicit trigger `3/3`；router `10/10` | 保留。 |
| 正文中的 `requirements-clarifier` | 相邻 Skill | 具体实施只缺局部关键歧义 | 是 | 否 | 否 | `export_clarify` `9/10` exact，1 次双加载 | 保留互斥 branch；不复制相邻正文。 |
| materialized `request_user_input` | Runtime tool | 选项能准确表达当前取舍 | 是 | 否 | 否 | 三个 behavior current 均按 case 需要调用 | 继续由环境提供 schema，不复制参数。 |

### Minimum Effective Control Audit

#### 最小行为合同

1. 仅在明确需要逐轮共同推演时进入；一次性回答、内部规划和局部实施澄清不进入。
2. 先查清事实和已有决定；可查事实不问用户。
3. 用户承担后果的决定交给用户；技术事实和待验证事项分开。
4. 只推进前提已明确的当前前沿；遵守显式依赖链，依赖不明时一题，确认独立时最多三题。
5. 不无依据推荐，不重开充分决定，不穷举低影响细节。
6. 重要分支决定、委托、待验证或明确延后后停止，并保留责任、期限、条件和风险。
7. 最终记录需确认或明确跳过；确认前不修改、原型或实施。

#### 控制面

| Signal | Count / observation | Risk |
| --- | ---: | --- |
| Mandatory stages | 3：建树、推进、收尾 | low |
| Hard gates | 1：最终记录确认，可由用户明确跳过 | low |
| Fixed intermediate artifacts | 0 | low |
| Prohibitions | 事实不问用户、不得代答、不得提前问下游、确认前不实施 | low |
| Conditional branches | inspector 计数 6 | low |
| Fixed output fields | 0；记录字段按需省略 | low |

#### 必要性映射与简化候选

| 当前行为块 | 改变的行为 | 依据 | 当前控制类型 | 模型默认能否处理 | 处理建议 | 删除或放宽风险 |
| --- | --- | --- | --- | ---: | --- | --- |
| 触发与非目标 | 防止直接任务变成长访谈 | 高 FN/FP 代价；trigger corpus | invariant | 否 | keep-invariant | 误触发或漏掉用户要求的访谈。 |
| 事实先查 | 防止把可查事实交给用户 | required behavior | default | 部分 | keep-default | 增加用户负担，重问已知事实。 |
| 用户所有的取舍 | 防止 agent 代替用户承担后果 | `natural-owner-choice` | invariant | 否 | keep-invariant | 把 agent 偏好写成用户决定。 |
| 当前前沿与每轮题数 | 防止无效下游问题和问题堆叠 | frontier cases | default/invariant | 部分 | keep-default | 产生依赖无效问题；`DG-F-002` 显示仍有方差。 |
| 不重开/不穷举 | 控制访谈长度 | diagnostic design；Skill goal | default | 部分 | keep-default | 访谈进入低影响细节。 |
| 决策记录 | 防止丢失委托、验证和风险 | release/diagnostic corpus | invariant | 部分 | keep-invariant | 交接信息丢失。 |
| 最终确认和确认前只读 | 确认共享理解并阻止提前实施 | `natural-owner-choice` | invariant | 否 | keep-invariant | 未确认记录被当成最终决定。 |
| 三层章节组织 | 提供导航，不直接增加行为 | reviewer heuristic | 是 | needs-ablation | 可能只影响导航；无证据支持新增结构。 |

复杂度结论：`proportionate`。正文约 762 tokens，没有固定中间 artifact、完整状态表或人工 SOP；可选简化只涉及组织和少量边界重复，reducibility 为 `minor`。

### Information Hierarchy Map

| 内容 | 类型 | 适用 branch | 当前位置 | 每次需要 | Pointer 或环境事实源 | 最小控制结论 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| 触发和相邻边界 | in-file-reference | 每次激活前 | description、导言 | 是 | Skill catalog | keep-invariant | 保留。 |
| 只读事实核对 | in-file-step | 建树 | `建立决策树` | 是 | 对话、代码、文档 | keep-default | 保留为默认。 |
| 决定/事实/验证分类 | in-file-reference | 建树 | `建立决策树` | 是 | 当前材料 | keep-invariant | 保留。 |
| 当前前沿 | in-file-step | 逐轮交互 | `推进当前前沿` | 是 | 用户给出的依赖链 | keep-default | 保留；先用 repetitions 处理方差。 |
| 问题工具字段和回答状态 | environment-lookup | 适合列选项时 | Runtime tool | 否 | `request_user_input` schema | keep-default | 不复制 schema。 |
| 决策记录与确认 | in-file-step | 收尾 | `收尾` | 是 | 当前会话 | keep-invariant | 保留。 |
| Eval corpus | disclosed-reference | 作者验证 | manifest | 否 | `suites[].cases` | 不属于 runtime 控制 | 继续与 runtime package 分离。 |

### Completion Boundary Audit

| 步骤或规则集 | 当前标准 | 清楚 | 可检查 | 要求充分 | 覆盖完整 | 提前完成风险 | 建议 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 事实核对 | 已查看对话、决定和相关代码/文档；可查事实不再作为用户问题 | 是 | 是 | 是 | 是 | 低 | 保留。 |
| 当前前沿 | 只问前提明确的最上游决定；回答后重算 | 是 | 是 | 是 | 是 | 中 | 保留；为 `DG-F-002` 增加同族重复。 |
| 停止 | 重要分支决定、委托、待验证或明确延后并接受风险 | 是 | 是 | 是 | 是 | 低 | 保留。 |
| 决策记录 | 只输出非空类别；委托含责任人、期限和条件 | 是 | 是 | 是 | 是 | 低 | 保留。 |
| 确认与交接 | 用户确认或明确跳过后交还原工作流 | 是 | 是 | 是 | 是 | 中 | 保留。 |
| 确认前只读 | diff 为空，无原型或实施 | 是 | 是 | 是 | 是 | 低 | 保留。 |

### Architecture and Ownership

- **Skill 负责的策略：** 触发边界、事实与决定分层、当前前沿、题数默认、停止、记录和确认不变量。
- **Schema 或客户端负责的事实：** 问题字段、选项结构、tool availability、materialized tool name、Skill 加载机制。
- **Runtime 负责的状态：** 当前轮次、问题等待、回答、取消、交接和实际 workspace 状态。
- **脚本候选：** 无；访谈取舍不是确定性转换。
- **仅属于 role 的约束：** 无独立 role。
- **仅属于 eval 或 issue 的问题：** 低频加载方差、paired root-cause、Claude 行为覆盖。
- **自然语言状态机风险：** low

### Scripts and Resources

- **已有脚本或正确省略：** production Skill 无 agent-facing script，正确省略；作者期有 contract test 和 eval fixture。
- **接口、依赖和安全质量：** fixture 只导入 `node:fs/promises` 与 `node:path`，按白名单 fixture 名称在 runner 提供的 `workspaceRoot` 写硬编码小文件；无网络、进程或删除。contract test 只读 source/bundle，临时样例使用 `mkdtemp`，并在 `finally` 删除自己的目录。
- **模型仍在重复的确定性逻辑：** 没有需要 runtime script 化的重复解析或转换。
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
| Policy rationale | 两类错误均会改变工作流，不用总体 accuracy 掩盖。 | corpus policy；router `forbidMultipleSkillLoads` |

#### Eval 门禁

| Gate | 状态 | 证据 | 原因 |
| --- | --- | --- | --- |
| `eval-validity` | pass | 3 strict + 1 compatible validator；人工 oracle audit | 关键层级、前提、oracle、minimal pair 和版本关系有效。 |
| `release-evidence` | fail | required `7/7`；releaseOutcome `failed` | 两个 required router target 失败。 |
| `eval-change-safety` | not_applicable | 生产 Skill 未修改 | 没有 eval-driven production change。 |

#### Suite 构成

| 指标 | 数量或判定 |
| --- | ---: |
| Cases | 57 |
| Scenario families | 35 |
| Decision boundaries / minimal pairs | 28 |
| Representative cases | 14 |
| Regression cases | 1 |
| Boundary cases | 27 |
| Challenge cases | 0 |
| Diagnostic-only cases | 15 |
| Stale / ambiguous cases | 0 |

3 份 required 文档共 42 cases 均 strict-valid；15 个 diagnostic cases compatible-valid。`behavior-diagnostic` 的 `requiredForRelease=false`，按默认完整 release 合同未执行，也未进入指标。

#### Case Admission 结果

| Case | 层级 | Role | Provenance | Oracle 置信度 | 前提充分 | Rule trace | 现实 | 决策 |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| single trigger 的 25 cases | trigger | representative / boundary | observed / derived / synthetic / boundary | high | 是 | 是 | 是 | release-counted |
| router 的 14 cases | routing | representative / regression / boundary | observed / derived / boundary | high | 是 | 是 | 是 | release-counted |
| `natural-access-frontier` | behavior | representative | derived | high | 是 | 是 | 是 | release-counted；current partial failure |
| `natural-owner-choice` | behavior | representative | derived | high | 是 | 是 | 是 | release-counted；qualitative pass |
| `natural-deferred-risk` | behavior | representative | derived | high | 是 | 是 | 是 | release-counted；qualitative pass |
| diagnostic 15 cases | behavior | diagnostic | mechanism-probe / derived | high | 是 | 是 | 诊断级 | diagnostic-only；未执行 |

上一正式报告中的 required oracle 问题已关闭：`natural-access-frontier` 现在明确提供已知产品目标，并声明 `product_goal_known=true`；current 也没有重问该目标。

#### Trigger 或其它二元决策结果

| 指标 | 当前结果 | Baseline / previous | 解释 |
| --- | ---: | ---: | --- |
| Standalone positive recall | 100% (`21/21`) | 无 | 全部发布正例加载 owner。 |
| Standalone false-negative rate | 0% | 无 | — |
| Standalone negative specificity | 100% (`24/24`) | 无 | validation/sanity near-miss 全部未加载。 |
| Standalone false-positive rate | 0% | 无 | — |
| Router decision-grill positive recall | 100% (`50/50`) | 无 | 全部目标访谈加载 owner。 |
| Router decision-grill false-negative rate | 0% | 无 | — |
| Router decision-grill negative specificity | 95.6% (`86/90`) | 无 | 4 次非目标 owner load。 |
| Router decision-grill false-positive rate | 4.4% (`4/90`) | 无 | 3 次为多 Skill，1 次为 `plan_review` owner-only。 |
| Router exact route | 96.4% (`135/140`) | 无 | 5 次 route mismatch，3 次多 Skill。 |
| Mixed / uncertain cases | `export_clarify`、`runner_recommend`、`plan_review`、`approved_plan_implementation_gap` | 无 | 先按 failure triage 处理，不直接修改 Skill。 |

#### Behavior、outcome 和 cost 证据

| Scenario family | With Skill | Baseline | Quality delta | Token/time delta | 方差 | 证据强度 |
| --- | --- | --- | ---: | ---: | --- | --- |
| dependent-decision-frontier | 两轮正确，但下一前沿插入额外分支 | 三题并列，未使用问题工具，2 replies 未消费 | mixed-positive | `+37,151` tokens；`+16.3s` | 1 current / 1 baseline | medium |
| user-owned-tradeoff | 读事实、只让用户选优先级、确认后交接 | 选优先级后直接结束，未确认 | positive | `+3,013` tokens；`+11.7s` | 1 / 1 | medium |
| explicit-deferral | 一轮后记录延后和风险并直接交接 | 只给问题，reply 未消费 | positive | `+13,684` tokens；`-0.3s` | 1 / 1 | medium |

成本增加主要来自真实多轮问题、Skill 读取和最终确认。当前没有产品成本阈值，也没有重复样本，因此不生成伪精确收益率。

#### Failure triage

| Case / assertion | Failure class | 可复现 | Root owner | 动作 | 理由 |
| --- | --- | ---: | --- | --- | --- |
| `export_clarify` 多 Skill load | model-variance | `1/10` | Client；Skill 根因未证明 | collect-more-data | 模型先正确说明只做 requirements clarification，随后读取两个 Skill。 |
| `runner_recommend` 多 Skill load | model-variance | `2/10` | Client；Skill 根因未证明 | collect-more-data | 两个失败 run 都先说明直接推荐、不进入访谈，之后读取两个 Skill。 |
| `plan_review` owner load | model-variance | `1/10` | 未证明 | collect-more-data | case 达到 0.9 minimum rate，但 owner 仍有一次非目标加载。 |
| `approved_plan_implementation_gap` missing route | model-variance | `1/10` | 未证明；不影响 owner FN | collect-more-data | 9/10 正确 requirements route；1/10 neither。 |
| `natural-access-frontier` 下一前沿 | insufficient-runs | 1 run | Client；Skill 根因未证明 | collect-more-data | 前两轮正确，只有 final frontier 偏离。 |
| `natural-owner-choice` | none | 1 run | — | accept | current 满足四项 qualitative checks。 |
| `natural-deferred-risk` | none | 1 run | — | accept | current 不代答，记录延后和风险并直接交接。 |
| 首轮 `runner_recommend` WebSocket 断线 | runtime-or-tool-defect | 首轮 2 errors；恢复后 0 | Provider/runtime | recovered | 同 batch-id 重跑 incomplete case 后 target complete。 |

#### Eval-driven 修改决策

- **修改内容：** 无生产修改。
- **受影响场景族：** 直接推荐、局部实施澄清、一次性评审、显式依赖前沿。
- **为什么是 Skill defect：** 当前没有证明根因属于 production Skill；router trace 反而显示模型先作出正确分类。
- **原始失败证据：** 完整 required run、恢复 run和 current/baseline traces。
- **Minimal pair / 相反标签风险：** description 改动可能伤害 `21/21` standalone recall、`50/50` router owner recall 或 requirements-clarifier 路由。
- **Validation、sanity 和 regression 重跑：** 本轮未修改，因此 change gate 不适用。
- **Quality delta：** 不适用。
- **Context / branch / maintenance delta：** 0；production source 未修改。
- **决策：** collect-more-data

#### Eval 维度

- **分数：** 4 / 5
- **置信度：** high
- **适用评分上限：** 有实际运行、baseline、trace、成本和 failure triage；behavior 单次样本与缺 paired root-cause 使其不达到 5。
- **摘要：** suite 和 oracle 可用于发布判断；当前失败是被测行为/客户端加载证据，不是已知错误 oracle。

#### 停止决定

停止扩写 Skill。下一步只增加能隔离 owner 和方差的 paired 证据；如果新证据不指向 production pointer，不对 `SKILL.md` 追加规则。

## Appendix F — 历史反证、执行记录和限制

### 上一报告问题关闭情况

- 2026-08-14 full 报告的 `F-001` 指出 `natural-access-frontier` 缺产品目标前提。当前 prompt 已明确产品目标，precondition 为 `product_goal_known=true`，strict validator 通过，current 没有重问产品目标。该 eval finding 已关闭。
- 上一报告记录的低频 near-miss 加载风险仍存在。本轮 standalone trigger 改善为全通过，但 router 仍有 4 次非目标 owner load，并在两个 required targets 上触发多 Skill 零容忍门禁。
- 上一报告的 confirmation 单次遗漏没有在本轮 required `natural-owner-choice` 重现；current 正确请求确认并在确认后交接。

### 运行命令和退出状态

| 命令 | 退出状态 | 说明 |
| --- | ---: | --- |
| `pnpm build` | 0 | 共享构建证据；构建包含 TypeScript 检查。 |
| `node .agents/skills/create-aw-plugin/scripts/validate_plugin.mjs plugins/ask-me --json` | 0 | `ok=true`；仅警告已有 release intent 且 production unchanged。 |
| `pnpm plugin:test ask-me --platform codex --scope project` | 0 | 7/7 tests pass。 |
| `node .agents/skills/skill-review/scripts/inspect_skill_target.mjs plugins/ask-me --format json` | 0 | source 无 issue。 |
| `validate_eval_cases.mjs <3 required docs> --strict --format json` | 0 | 42 required cases，0 error，0 warning。 |
| `validate_eval_cases.mjs <diagnostic doc> --format json` | 0 | 15 diagnostic cases，0 error，0 warning。 |
| `pnpm plugin:eval ask-me --skill decision-grill --batch-name release-review-20260815` | 1 | 首轮因两次 WebSocket 断线在 router sanity checkpoint incomplete；batch `5/7`。 |
| `pnpm plugin:eval ask-me --skill decision-grill --batch-id 20260815T073504Z-release-review-20260815-4ceb14db` | 1 | 恢复同批次；complete `7/7`，releaseOutcome failed。 |
| `inspect_skill_target.mjs plugins/ask-me --evaluation <current raw/evaluation.json> --format json` | 1 | 预期报告 `evaluation.failed` 和 qualitative-review warning；source/final package 无新 issue。 |
| `validate_scorecard.mjs <scorecard.json> --format json` | 0 | schema valid；设计 needs-fixes；发布 blocked；87.2 strong。 |

### 环境和证据限制

- 真实模型证据只覆盖 Codex `gpt-5.6-luna`、Codex CLI `0.147.0`、provider `openai-oauth`。
- Process management 为 `managed`，`descendantCleanupGuaranteed=true`；未使用 `--allow-unmanaged-processes`。
- user-default 只有 materialization evidence，没有 Codex native user-cache 模型运行；这是 manifest 的既定合同。
- Behavior current/baseline 每 case 只有 1 次。Trigger 为 3 次，router 为 10 次。
- 非发布 `behavior-diagnostic` suite 未执行，符合默认完整 release 只运行 `requiredForRelease` suite 的合同。
- 本轮无 eval-driven production 修改，因此 `eval-change-safety=not_applicable`。
- 正式报告发布已授权；README 登记未授权。不会运行 `review:release`，不会修改 README、Skill、eval corpus 或 plugin source。
