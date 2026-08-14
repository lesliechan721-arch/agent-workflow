# requirements-clarifier 完整评审

## 结论

- **Skill：** `requirements-clarifier`
- **模式：** full
- **方向：** at-risk
- **复杂度：** proportionate
- **可缩减程度：** minor
- **发布结论：** pass-after-fixes
- **加权总分：** 86.0
- **原始质量带：** strong
- **有效质量带：** strong
- **覆盖率：** 100%
- **置信度：** high（0.92）
- **一句话结论：** Skill 主体的三路澄清程序可靠；但一个发布级性能 case 使用无效 oracle，必须先修 eval，再取得可信发布证据。

本报告是 full 质量评审，不是 release 模式。它没有核对外部 current-check 来源。模型行为证据只覆盖 Codex；Claude 只完成确定性最终制品验证。

本轮使用 `skill-review` 的 full 工作流。用户已授权正式发布；`review:publish` 会写正式报告并封存批次，但不会更新 Skill README。

## 评审合同

| 项目 | 从材料提取的结论 | 状态 |
| --- | --- | --- |
| 目标问题 | 实施前用最少问题补齐会造成结果偏差或返工的关键需求边界 | known |
| 已观察失败 | 纯决策访谈有 3/10 误触发；性能 release case 的 oracle 与缺失实施输入冲突 | known |
| 成功标准 | 先读事实；不确定项分为询问、默认、验证；只问高成本歧义；停止并交接 | known |
| 目标环境或客户端 | Codex project/user model behavior；Codex/Claude plugin artifact | known |
| 范围外事项 | 纯内部选择、已有明确惯例、用户已委托默认值、完整规范、纯决策访谈 | known |
| 相邻 Skill | `decision-grill` | known |
| 发布要求 | project/user materialization、trigger validation、release behavior | known |

## 发布门禁

| Gate ID | 状态 | 严重性 | Finding IDs | 证据 | 原因 |
| --- | --- | --- | --- | --- | --- |
| package-validity | pass | P0 | — | validator、source/project/user artifact | 结构、名称、引用和最终制品有效 |
| critical-artifacts | pass | P0 | — | owner manifest、digest | 核心文件存在且匹配 |
| goal-alignment | pass | P0 | — | SKILL.md、trace | 目标和授权边界一致 |
| capability-validity | pass | P0 | — | materialization、双平台 plugin:test | 问题工具和最终制品可用 |
| safety-permissions | pass | P0 | — | strict isolation、workspace diff | 澄清期间没有修改 workspace |
| architecture-ownership | pass | P1 | — | architecture audit | runtime 管理会话状态 |
| release-evidence | fail | P1 | RC-F-001 | release bundle、trace | 必需 behavior suite 被无效 oracle 判为失败，当前没有可信完整发布证据 |
| eval-validity | fail | P1 | RC-F-001 | case admission、current/baseline trace | 性能 case 把缺失的集群、负载和代码输入错误视为已定义 |
| eval-change-safety | not_applicable | P1 | — | 无修改 | 本轮没有 eval-driven Skill 修改 |

## 优点

- source、Codex project/user 和 Claude 确定性最终制品有效。Codex/Claude 在 project/user scope 的 plugin:test 各 7/7 通过。
- 单 Skill trigger 共 20 个 case、60 次默认运行。validation 正负各 15 次，正例 recall 93.3%，负例 specificity 100%。
- 两个混合正例各补跑 10 次，均恢复为 10/10 正确加载。
- `natural-mixed-ambiguity` 正确采用已知 10 分钟事实、保留内部默认，只询问用户可见宽限期。
- `natural-combined-ambiguities` 在一轮内分别确认三个独立但组合影响功能形态的问题。
- 10 个 diagnostic behavior 的 current 全部机械通过。已知事实、三路路由、上游前沿、冲突、问题形态、停止和交接都有 trace。
- Skill 只有一个短正文，无 runtime reference、asset 或自然语言状态机。

## 必须修复的问题

| ID | 严重性 | 证据类型 | 维度 | 位置 | 受影响场景 | 证据 | 反证检查 | 正确 owner | 最小修改 | 验证方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RC-F-001 | P1 | observed, structural, normative | evals | `requirements-clarifier-release-evals.json: natural-engineering-evidence` | 性能目标明确但实施环境、负载和代码输入缺失 | current 只询问代码位置、集群规格、标准负载，没有让用户主观确认可行性；baseline 也列出这些缺失，但因不用工具而通过；同 corpus 的 `engineering-validation` 明确把这些项列为应确认 | QPS、时长、P99 和错误率只是目标，不是可复现的环境和负载；Skill 禁止让用户替技术事实拍板，current 未违反 | Eval | 二选一：补齐代码、集群、负载和测量边界，使零问题 oracle 成立；或允许询问这些实施输入，只禁止询问主观可行性。不要改 Skill 迎合当前 assertion | 严格 case validator + 人工 admission；干净批次复跑全部 behavior release case并读 current/baseline trace |

## 非阻断问题

| ID | 严重性 | 证据类型 | 维度 | 位置 | 观察 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| RC-F-002 | P2 | observed | triggering | n05、n02、n03 trigger | 纯决策访谈扩展误载 3/10；已有惯例和默认委托各 1/10 | 只替换 description 的交叉 near-miss 句；不增加正文阶段 |
| RC-F-003 | P2 | observed, heuristic | problem_value | 13 个 behavior case | 10 个 diagnostic baseline 全部通过；current tokens 高约 30%，无统一盲评质量分 | 增加 2–3 个不规定题数和工具形态的自然任务 |
| RC-F-004 | P2 | observed, structural | scope_composition | 两个 frontmatter、n05 | “功能/权限模型”词面使纯访谈仍偶发进入 requirements-clarifier | 与 RC-F-002 同一轮改交叉 pointer，不复制路由表 |

## 未知项

| ID | 维度 | 描述 | 所需证据 |
| --- | --- | --- | --- |
| RC-U-001 | instruction_design | 用户停止回答时的 trace 没有明确描述具体返工风险 | 重复自然停止 case，并人工检查具体风险表达 |
| RC-U-002 | minimum_control | 没有三题上限、组合小歧义或最小合同的规则级 ablation | 比较当前 Skill、最小合同和逐项删除控制的重复行为 |
| RC-U-003 | reliability | Claude 最终制品有效，但没有 Claude 模型行为结果 | 运行等价 Claude model eval，或把行为声明限制为 Codex |

## 维度评分

| 维度 | 权重 | 分数 | 置信度 | 证据 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- | --- |
| 规范与包完整性 | 6 | 5.0 | high | validator、最终制品 | — | — | 完整有效 |
| 问题基础与实际价值 | 8 | 4.0 | medium | current/baseline trace | RC-F-003 | — | 有价值，增益量化有限 |
| 调用策略、触发条件与 Context Pointer | 10 | 3.5 | high | 20-case trigger、五个补跑 case、shared router | RC-F-002 | — | release validation 达标，边界误触发可复现 |
| 范围、边界与组合性 | 8 | 4.5 | high | 两个 description、n05 trace | RC-F-004 | — | 主体清楚，交叉 pointer 局部重叠 |
| 程序与完成边界 | 10 | 4.5 | high | 13 个 current behavior trace | — | RC-U-001 | 程序可靠，停止风险表达证据窄 |
| 最小充分控制与模型自由度 | 14 | 4.5 | medium | 最小控制审计、对照 | — | RC-U-002 | 控制适度，缺 ablation |
| 信息层级、资源与渐进式披露 | 10 | 5.0 | high | 单一短文件 | — | — | 无披露负担 |
| 职责归属与自然语言状态机风险 | 10 | 5.0 | high | inspector、runtime boundary | — | — | risk low |
| 脚本与确定性自动化 | 7 | 5.0 | high | 双平台 plugin:test | — | — | 正确省略 agent script |
| Eval 设计、Oracle 有效性与修改安全 | 9 | 2.0 | high | 33 case、invalid release oracle、failure triage | RC-F-001 | — | 发布级 oracle 无效 |
| 可靠性、安全与兼容性 | 4 | 4.0 | medium | Codex model、双平台 artifact | — | RC-U-003 | Claude 行为未知 |
| 剪枝、事实源与变更纪律 | 4 | 5.0 | high | 单一 source、release intent | — | — | 无明显沉积 |

## 调用与 Context Pointer 审计

| Pointer | 目标材料 | 触发 branch | 意图是否前置 | 是否重复同义 branch | 是否重复正文身份 | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| frontmatter description | `requirements-clarifier` | 实现任务仍有高成本、用户可见关键歧义 | 是 | 否 | 少量 | 20-case trigger、五个补跑 case | 把纯访谈排除句移到泛化实施句之前 |
| description / 正文相邻 pointer | `decision-grill` | 当前任务本身是逐轮推演和共享理解 | 是 | 否 | 否 | n05 扩展 3/10 误载 | 与另一个 description 保持互斥短句 |
| `agents/openai.yaml` | 显式 Skill 入口 | 用户显式调用 | 是 | 否 | 否 | materialization、plugin:test | 保留 |

## 最小有效控制审计

### 最小行为合同

1. 只在具体实现仍有高成本、用户可见关键歧义时激活。
2. 先查事实、规范、惯例和已有决定，不重问可查信息。
3. 将剩余不确定项分为询问、默认或待验证。
4. 单项影响小但组合决定功能形态时仍要澄清。
5. 上游优先；独立问题每轮最多三项。
6. 工具和推荐必须准确；冲突要求由用户选最小调整。
7. 无关键歧义或用户停止时交接，并保留默认、验证、未解决和风险。
8. 澄清期间不修改文件、不做原型、不实施。

### 控制面

| Signal | Count / observation | Risk |
| --- | ---: | --- |
| Mandatory stages | 3：处理不确定项、提问、结束 | low |
| Hard gates | 1：有关键歧义才继续提问 | low |
| Fixed intermediate artifacts | 0 | low |
| Prohibitions | 5 个主要不变量 | low |
| Conditional branches | 6 个触发/默认/验证/冲突/停止分支 | low |
| Fixed output fields | 3 个按需字段，可省略空项 | low |

### 必要性映射与简化候选

| 当前行为块 | 改变的行为 | 依据 | 当前控制类型 | 模型默认能否处理 | 处理建议 | 删除或放宽风险 |
| --- | --- | --- | --- | ---: | --- | --- |
| 触发与 near-miss | 避免所有非平凡实现都提问 | trigger corpus | invariant | 不稳定 | keep-invariant | 多余阻塞 |
| 只读事实检查 | 避免重问事实和惯例 | behavior trace | invariant | 不稳定 | keep-invariant | 用户负担和返工 |
| 询问/默认/验证 | 区分用户决定与技术事实 | mixed、engineering trace | invariant | 不稳定 | keep-invariant | 让用户替技术事实拍板 |
| 组合小歧义 | 避免多个小默认共同改变功能形态 | combined case | default | 部分 | needs-ablation | 静默改变体验 |
| 上游与三题上限 | 控制顺序和认知负担 | dependent trace | default | 部分 | needs-ablation | 下游问题无效、问题过多 |
| 准确工具和推荐 | 防止伪选项和伪依据 | question-shape trace | invariant | 不稳定 | keep-invariant | 误导用户 |
| 冲突最小调整 | 防止静默放宽硬约束 | conflict trace | invariant | 不稳定 | keep-invariant | 验收不一致 |
| 停止与不实施 | 保留控制权并避免过问 | stop/handoff、安全 trace | invariant | 不稳定 | keep-invariant | 未授权实施或无休止提问 |

复杂度为 `proportionate`。核心行为都是实施前对齐的必要控制；可缩减项仅是触发 pointer 和启发式措辞。

## 信息层级图

| 内容 | 类型 | 适用 branch | 当前位置 | 是否每次需要 | 到达 pointer 或环境事实源 | 最小控制结论 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| 激活和 near-miss | in-file-reference | 每次发现 | description | 是 | Skill catalog | keep-invariant | 调整交叉句顺序 |
| 三路不确定性处理 | in-file-step | 澄清开始 | SKILL.md | 是 | 正文 | keep-invariant | 保留 |
| 提问和冲突 | in-file-step | 需要用户决定 | SKILL.md | 否 | 正文 | keep-invariant | 保留 |
| 停止和交接 | in-file-step | 无关键歧义或用户停止 | SKILL.md | 是 | 正文 | keep-invariant | 保留 |
| 代码、配置、文档、惯例 | environment-lookup | 有材料时 | 仓库与对话 | 否 | 环境 | keep-invariant | 不缓存 |
| eval corpus 和 trace | disclosed-reference | 作者评测 | `evals/`、`.tmp/` | 否 | owner manifest | 不进 runtime | 保持隔离 |

## 完成边界审计

| 步骤或规则集 | 当前标准 | 清楚 | 可检查 | 要求充分 | 覆盖完整 | 提前完成风险 | 建议 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 事实检查 | 已说明或可查事实直接采用 | 是 | 是 | 是 | 是 | low | 保留 |
| 三路处理 | 按返工代价和证据选择问、默认、验证 | 是 | 是 | 是 | 是 | low | 保留 |
| 当前前沿 | 上游优先，独立时最多三题 | 是 | 是 | 是 | 是 | low | 保留，做 ablation |
| 冲突 | 指出冲突，让用户选最小调整 | 是 | 是 | 是 | 是 | low | 保留 |
| 停止和交接 | 无关键歧义时交还；用户停止时保留风险 | 是 | 部分 | 是 | 是 | medium | 增加具体风险的自然 trace，不先加规则 |

## 架构与职责归属

- **Skill 负责的策略：** 触发、事实检查、三路处理、提问顺序、冲突和停止。
- **Schema 或客户端负责的事实：** 问题结构、选项、question id 和用户答复。
- **Runtime 负责的状态：** 当前会话、等待、回复顺序和工具生命周期。
- **脚本候选：** 没有。返工代价、产品可见性和证据类型需要语义判断。
- **仅属于 role 的约束：** 没有独立 role。
- **仅属于 eval 或 issue 的问题：** invalid engineering oracle、自然增益 case 强度、Claude 模型覆盖。
- **自然语言状态机风险：** low

## 脚本与资源

- **已有脚本或正确省略：** agent-facing script 正确省略；插件合同和 fixture 使用作者侧 Node 脚本。
- **接口、依赖和安全质量：** 双平台、双 scope plugin:test 通过；行为运行使用 strict isolation。
- **模型仍在重复的确定性逻辑：** 没有明显候选。
- **Reference 和 asset 可达性：** runtime 无 reference；eval 从 owner manifest 一层可达。
- **重复：** description 和正文只有必要的激活/运行边界重复。
- **Scattering 与 co-location：** 核心流程都在一个短文件。
- **不必要缓存的环境事实：** 没有。
- **过期或孤立资源：** 没有 runtime 孤立资源。

## Eval Case Audit

- **Optimization policy 与错误代价：** 误触发会阻塞已明确实现；漏触发会静默选择用户可见行为。对权限、数据和验收的 false negative 代价高；对明确惯例和默认委托的 false positive 也需控制。已知无效 oracle 不得驱动 Skill 修改。
- **门禁：** `eval-validity=fail`；`release-evidence=fail`；`eval-change-safety=not_applicable`。
- **Suite 构成：** owner trigger 20 case、19 families（9 representative、1 regression、10 boundary）；release behavior 3 representative/3 families；diagnostic behavior 10 diagnostic/10 families。11 个 trigger case 有 minimal-counterexample rule trace；行为 case 使用 current/without-owner 对照。shared router 14 case 是相邻组合证据。
- **Case Admission：** 3 个 owner case 文件和 shared router 均通过严格结构 validator。`natural-engineering-evidence` 的结构合法，但语义 admission 失败：oracle 把缺失实施输入当成完整验收口径。
- **二元决策指标：** 默认 validation positive recall 93.3%、FNR 6.7%；negative specificity 100%、FPR 0%。train positive recall 93.3%；negative specificity 73.3%、FPR 26.7%。扩展样本：p03 10/10、p07 10/10；n02 FPR 10%、n03 FPR 10%、n05 FPR 30%。
- **Mixed / uncertain cases：** 五个默认 mixed case 全部扩展到 10 次。正例不稳定未复现；纯访谈误触发持续 3/10；其它两个 false positive 降到 1/10。
- **Baseline、trace、token/time 和方差：** release+diagnostic 各 13 组 current/baseline；读取全部问题与最终消息。current 520191 tokens / 260354 ms；baseline 399504 / 271190 ms。current 多约 30% tokens，wall time 少约 4%。
- **Failure triage：** `natural-engineering-evidence` 是 Eval defect；n05 是 Skill trigger/composition P2；n02/n03 是低频边界；其它行为 current 正常。
- **Eval-driven 修改决策：** `fix-eval-first`。在 oracle 修复前拒绝因该 release failure 修改 Skill；本轮没有修改。
- **发布仍缺少的证据：** 修复后的 engineering case admission 和完整 behavior release rerun；触发 pointer 修改后的完整 trigger/router 回归。

主 eval batch：`.tmp/agent-workflows/evals/plugin/ask-me/requirements-clarifier/20260813T164655Z-full-review-20260814-materialization-c2fcf984/`

触发补跑证据：`.tmp/agent-workflows/evals/plugin/ask-me/requirements-clarifier/20260813T201420Z-full-review-20260814-trigger-reruns-db403e6c/`

## 差量与沉积

- **上一版 P0/P1 关闭情况：** 本轮不是 delta；不以旧报告作为关闭合同。
- **受影响维度：** evals、triggering、scope_composition、problem_value。
- **直接回归：** 全部声明 suite 已执行；五个混合 case 已补跑。
- **SKILL.md、pointer、branch 和资源变化：** 本轮无修改。
- **行为指标变化：** 不适用；这是当前源码的独立评审。
- **最小行为合同与复杂度结论变化：** 当前为 proportionate/minor。
- **新增规则及其替代内容：** 无。
- **沉积候选：** 没有 runtime 沉积；只需修 eval 和局部 pointer。
- **净变化：** neutral

## 最小改进路线

### 现在——发布阻断

1. 修正 `natural-engineering-evidence` 的前提或 oracle，不修改 Skill 迎合错误 assertion。
2. 人工重新 admission 后，以干净批次复跑全部 release-required suite。

### 下一步——高价值质量改进

1. 只替换两个 Skill 的交叉 description 句，降低纯访谈 3/10 误触发。
2. 完整复跑 single trigger 和 shared router，不只复跑目标 case。

### 以后——启发式、评测或产品/runtime 工作

1. 增加自然低提示 behavior case 和盲评。
2. 做三题上限、组合小歧义和最小合同的规则级 ablation。
3. 如需 Claude 行为兼容声明，运行 Claude 模型证据。

## 停止决定

现在停止评审。全部声明 case、必要 trace 和五个混合结果补跑已经完成，证据足以区分 Skill defect、eval defect 和未知项。用户要求的是评审和发布报告，不是修复；在修正 oracle 并产生新 release batch 前，不应根据当前失败改动 Skill。
