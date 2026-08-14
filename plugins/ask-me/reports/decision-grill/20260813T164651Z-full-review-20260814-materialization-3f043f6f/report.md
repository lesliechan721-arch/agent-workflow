# decision-grill 完整评审

## 结论

- **Skill：** `decision-grill`
- **模式：** full
- **方向：** at-risk
- **复杂度：** proportionate
- **可缩减程度：** minor
- **发布结论：** pass-after-fixes
- **加权总分：** 85.1
- **原始质量带：** strong
- **有效质量带：** strong
- **覆盖率：** 100%
- **置信度：** high（0.92）
- **一句话结论：** Skill 小而清楚，触发和多数访谈行为稳定；但核心“依赖前沿”在一个代表性发布场景中仅 1/4 次按目标顺序执行，修复后才可通过。

本报告是 full 质量评审，不是 release 模式。它没有核对外部 current-check 来源。模型行为证据只覆盖 Codex；Claude 只完成确定性最终制品验证。

本轮使用 `skill-review` 的 full 工作流。用户已授权正式发布；`review:publish` 会写正式报告并封存批次，但不会更新 Skill README。

## 评审合同

| 项目 | 从材料提取的结论 | 状态 |
| --- | --- | --- |
| 目标问题 | 通过逐轮访谈把计划、决策或想法想透，并形成共享理解 | known |
| 已观察失败 | 依赖链访谈会先问未显式给出的产品发现问题、内部角色或并列下游事项 | known |
| 成功标准 | 正确触发；查明事实；按依赖前沿提问；保留用户决定；形成并确认记录 | known |
| 目标环境或客户端 | Codex project/user model behavior；Codex/Claude plugin artifact | known |
| 范围外事项 | 一次性说明、比较、推荐、评审、agent 内部计划和普通实施澄清 | known |
| 相邻 Skill | `requirements-clarifier` | known |
| 发布要求 | project/user materialization、trigger validation、shared router validation、release behavior | known |

## 发布门禁

| Gate ID | 状态 | 严重性 | Finding IDs | 证据 | 原因 |
| --- | --- | --- | --- | --- | --- |
| package-validity | pass | P0 | — | validator、source/project/user artifact | 结构、名称、引用和最终制品有效 |
| critical-artifacts | pass | P0 | — | owner manifest、digest | 核心文件存在且匹配 |
| goal-alignment | pass | P0 | — | SKILL.md、trace | 目标和授权边界一致 |
| capability-validity | pass | P0 | — | materialization、双平台 plugin:test | 问题工具和最终制品可用 |
| safety-permissions | pass | P0 | — | strict isolation、workspace diff | 确认前没有修改 workspace |
| architecture-ownership | pass | P1 | — | architecture audit | runtime 管理会话状态 |
| release-evidence | fail | P1 | DG-F-001 | release trace + 独立补跑 | `natural-access-frontier` 仅 1/4 current 轨迹按依赖顺序推进 |
| eval-validity | pass | P1 | — | case admission audit | 该 release oracle 的依赖关系、前提和 scripted replies 有效 |
| eval-change-safety | not_applicable | P1 | — | 无修改 | 本轮没有 eval-driven Skill 修改 |

## 优点

- source、Codex project/user 和 Claude 确定性最终制品有效。Codex/Claude 在 project/user scope 的 plugin:test 各 7/7 通过。
- 单 Skill trigger 共 20 个 case、60 次默认运行。唯一原始混合正例补跑为 10/10。
- shared router 共 14 个 case、140 次默认运行。validation 是 79/80 exact route，无双 Skill 加载。
- `natural-owner-choice` 和 `natural-deferred-risk` 正确保留用户决定、延后风险和交接边界。
- 15 个 diagnostic behavior 的 current 全部机械通过。事实检查、重新打开决定、停止、记录和最终确认路径均有 trace。
- 18 个 current behavior 会话比 without-owner baseline 少 8.5% tokens，wall time 少约 18%。
- Skill 只有一个短正文，无 runtime reference、asset 或自然语言状态机。

## 必须修复的问题

| ID | 严重性 | 证据类型 | 维度 | 位置 | 受影响场景 | 证据 | 反证检查 | 正确 owner | 最小修改 | 验证方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DG-F-001 | P1 | observed, normative | instruction_design | `SKILL.md:27-33`；`natural-access-frontier` | 合作产品、权限和计费等明确依赖链的访谈 | 原始 current 先问首要价值、再问内部角色；独立补跑 3 次仅 1 次按目标用户→访问边界推进，另一次每轮并列 3 题并机械失败 | 两个 diagnostic frontier case 可通过；其它两个 release case 可通过；baseline 同样偏移，但不能推翻 owner Skill 未稳定执行自身核心规则 | Skill | 替换抽象“上游优先”句：先选用户已显式给出的依赖链最上游节点；不自行插入新的发现问题；独立性未证实时不并列。不要增加新阶段 | 干净批次复跑全部 release suite；该 case 至少 10 次，第一、二轮 exact frontier 均不低于 0.9 |

## 非阻断问题

| ID | 严重性 | 证据类型 | 维度 | 位置 | 观察 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| DG-F-002 | P2 | observed, structural | evals | router sanity `full_spec` | 20/20 路由均正确为 neither，但模型在只读 fixture 继续实现，两个批次出现 1 次和 2 次 timeout | 让 fixture 在 no-Skill 判定后结束，或把任务约束为只读路由判断 |
| DG-F-003 | P2 | observed, heuristic | problem_value | 18 个 behavior case | 多数强提示 baseline 也通过；增益主要是结构、成本和少数低提示路径 | 用 2–3 个自然低提示 case 替换最强指令型 diagnostic prompt |
| DG-F-004 | P2 | observed | triggering | router sanity | 直接推荐、已有惯例、已委托默认值各有 1/10 误路由 | 先修 P1 并复跑；仍重复时只替换 description 的 near-miss 句 |

## 未知项

| ID | 维度 | 描述 | 所需证据 |
| --- | --- | --- | --- |
| DG-U-001 | minimum_control | 没有三题上限、最终确认或最小合同的规则级 ablation | 比较当前 Skill、最小合同和逐项删除控制的重复行为 |
| DG-U-002 | reliability | Claude 最终制品有效，但没有 Claude 模型行为结果 | 运行等价 Claude model eval，或把行为声明限制为 Codex |

## 维度评分

| 维度 | 权重 | 分数 | 置信度 | 证据 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- | --- |
| 规范与包完整性 | 6 | 5.0 | high | validator、最终制品 | — | — | 完整有效 |
| 问题基础与实际价值 | 8 | 4.0 | medium | current/baseline、成本 | DG-F-003 | — | 有增益，但自然质量差异证据有限 |
| 调用策略、触发条件与 Context Pointer | 10 | 4.0 | high | 20-case trigger、14-case router、补跑 | DG-F-004 | — | 主体稳定，少量边界误路由 |
| 范围、边界与组合性 | 8 | 5.0 | high | 两个 description、router trace | — | — | 职责整体清楚 |
| 程序与完成边界 | 10 | 2.5 | high | 4 条 release current trace | DG-F-001 | — | 核心依赖前沿重复失败 |
| 最小充分控制与模型自由度 | 14 | 4.0 | medium | 最小控制审计、diagnostic | — | DG-U-001 | 控制适度，缺 ablation |
| 信息层级、资源与渐进式披露 | 10 | 5.0 | high | 单一短文件 | — | — | 无披露负担 |
| 职责归属与自然语言状态机风险 | 10 | 5.0 | high | inspector、runtime boundary | — | — | risk low |
| 脚本与确定性自动化 | 7 | 5.0 | high | 双平台 plugin:test | — | — | 正确省略 agent script |
| Eval 设计、Oracle 有效性与修改安全 | 9 | 3.5 | high | 52 case、trace、failure triage | DG-F-002 | — | 覆盖强，sanity fixture 污染完整性 |
| 可靠性、安全与兼容性 | 4 | 4.0 | medium | Codex model、双平台 artifact | — | DG-U-002 | Claude 行为未知 |
| 剪枝、事实源与变更纪律 | 4 | 5.0 | high | 单一 source、release intent | — | — | 无明显沉积 |

## 调用与 Context Pointer 审计

| Pointer | 目标材料 | 触发 branch | 意图是否前置 | 是否重复同义 branch | 是否重复正文身份 | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| frontmatter description | `decision-grill` | 明确逐轮访谈、共同推演、外层访谈阶段 | 是 | 否 | 少量 | trigger 20 case；p07 补跑 10/10 | 保留主体 |
| description / 正文的相邻 pointer | `requirements-clarifier` | 实施任务只有局部关键歧义 | 是 | 否 | 否 | shared router 14 case | 只在重复误路由后改写 near-miss |
| `agents/openai.yaml` | 显式 Skill 入口 | 用户显式调用 | 是 | 否 | 否 | materialization、plugin:test | 保留 |

## 最小有效控制审计

### 最小行为合同

1. 只在用户或外层工作流明确需要逐轮协作决策时激活。
2. 先查事实和旧决定；分开事实、用户取舍和待验证事项。
3. 建立依赖前沿；上游优先；独立问题每轮最多三项。
4. 不替用户决定重大取舍，不用无依据推荐包装偏好。
5. 不为完整而重开有依据的决定或穷举低影响细节。
6. 分支已决定、委托、待验证或延后并接受风险时停止。
7. 保存并确认决定记录；用户更正时重开对应分支。
8. 确认前不修改文件、不做原型、不实施。

### 控制面

| Signal | Count / observation | Risk |
| --- | ---: | --- |
| Mandatory stages | 3：建立、推进、收尾 | low |
| Hard gates | 1：最终记录确认或显式跳过 | low |
| Fixed intermediate artifacts | 0；决策树是思考结构 | low |
| Prohibitions | 5 个主要不变量 | low |
| Conditional branches | 5 个事实/取舍/验证/重开/停止分支 | low |
| Fixed output fields | 6 个按需字段，可省略空项 | low |

### 必要性映射与简化候选

| 当前行为块 | 改变的行为 | 依据 | 当前控制类型 | 模型默认能否处理 | 处理建议 | 删除或放宽风险 |
| --- | --- | --- | --- | ---: | --- | --- |
| 只读事实检查 | 避免向用户问可查事实 | 目标、diagnostic trace | invariant | 不稳定 | keep-invariant | 重复提问 |
| 依赖前沿 | 避免下游或无关问题提前 | DG-F-001、normative oracle | invariant | 不稳定 | keep-invariant | scripted answer 错位、无效选择 |
| 每轮最多三题 | 限制认知负担 | heuristic、case contract | default | 部分 | needs-ablation | 用户负担增加 |
| 用户拥有后果取舍 | 防止 agent 代答 | owner-choice trace | invariant | 不稳定 | keep-invariant | 用户控制丢失 |
| 推荐需依据 | 防止偏好伪装事实 |目标、diagnostic | invariant | 不稳定 | keep-invariant | 误导选择 |
| 停止和按需记录 | 防止穷举或遗漏 | diagnostic trace | invariant | 不稳定 | keep-invariant | 交接不完整 |
| 最终确认 | 建立共享理解 | 核心目标 | invariant | 部分 | keep-invariant | 记录未获认可 |
| 确认前不实施 | 保留授权边界 | safety、workspace trace | invariant | 不稳定 | keep-invariant | 未授权副作用 |

复杂度为 `proportionate`。局部措辞需要更可执行，但不需要新阶段、reference 或状态机。

## 信息层级图

| 内容 | 类型 | 适用 branch | 当前位置 | 是否每次需要 | 到达 pointer 或环境事实源 | 最小控制结论 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| 激活和 near-miss | in-file-reference | 每次发现 | description | 是 | Skill catalog | keep-invariant | 保留 |
| 决策拆解和前沿 | in-file-step | 访谈开始和每轮 | SKILL.md | 是 | 正文 | keep-invariant | 替换抽象前沿句 |
| 停止和记录 | in-file-step | 分支完成 | SKILL.md | 是 | 正文 | keep-invariant | 保留 |
| 代码、文档、已有决定 | environment-lookup | 有材料时 | 仓库与对话 | 否 | 环境 | keep-invariant | 不缓存 |
| eval corpus 和 trace | disclosed-reference | 作者评测 | `evals/`、`.tmp/` | 否 | owner manifest | 不进 runtime | 保持隔离 |

## 完成边界审计

| 步骤或规则集 | 当前标准 | 清楚 | 可检查 | 要求充分 | 覆盖完整 | 提前完成风险 | 建议 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 事实检查 | 已知事实采用；可查事实自行确认 | 是 | 是 | 是 | 是 | low | 保留 |
| 当前前沿 | 前置决定明确后才问；回答后重算 | 部分 | 是 | 否 | 是 | high | 按 DG-F-001 替换为可操作判据 |
| 停止 | 分支均有决定、委托、验证或延后风险 | 是 | 是 | 是 | 是 | low | 保留 |
| 决策记录 | 按需记录 owner、期限、条件和未解决项 | 是 | 是 | 是 | 是 | low | 保留 |
| 最终确认 | 确认或显式跳过后交接 | 是 | 是 | 是 | 是 | low | 保留 |

## 架构与职责归属

- **Skill 负责的策略：** 触发、事实与取舍分离、依赖前沿、停止和记录。
- **Schema 或客户端负责的事实：** 问题结构、选项、question id 和用户答复。
- **Runtime 负责的状态：** 当前会话、等待、回复顺序和工具生命周期。
- **脚本候选：** 没有。依赖关系和决策 owner 需要语义判断。
- **仅属于 role 的约束：** 没有独立 role。
- **仅属于 eval 或 issue 的问题：** `full_spec` 只读超时、自然增益 case 强度、Claude 模型覆盖。
- **自然语言状态机风险：** low

## 脚本与资源

- **已有脚本或正确省略：** agent-facing script 正确省略；插件合同和 fixture 使用作者侧 Node 脚本。
- **接口、依赖和安全质量：** 双平台、双 scope plugin:test 通过；行为运行使用 strict isolation。
- **模型仍在重复的确定性逻辑：** 没有明显候选。
- **Reference 和 asset 可达性：** runtime 无 reference；eval 从 owner manifest 一层可达。
- **重复：** description 和正文只有必要的触发/运行边界重复。
- **Scattering 与 co-location：** 核心流程都在一个短文件。
- **不必要缓存的环境事实：** 没有。
- **过期或孤立资源：** 没有 runtime 孤立资源。

## Eval Case Audit

- **Optimization policy 与错误代价：** 访谈误触发会增加用户负担；漏触发会丢失共享理解；对重大决策的前沿错序代价高于少量额外澄清。release 采用高置信代表性 case；diagnostic 不直接阻断发布。
- **门禁：** `eval-validity=pass`；`release-evidence=fail`；`eval-change-safety=not_applicable`。
- **Suite 构成：** owner trigger 20 case、16 families（7 representative、13 boundary）；shared router 14 case、9 families（2 representative、1 regression、11 boundary）；release behavior 3 representative/3 families；diagnostic behavior 15 diagnostic/13 families。39 个 trigger/router case 提供 minimal-counterexample rule trace；行为 case 使用 current/without-owner 对照。
- **Case Admission：** 7 个 case 文件全部通过严格 case validator，无错误或警告。`natural-access-frontier` 的目标用户→访问边界→权限/计费依赖明确，oracle、回复和现实性一致。
- **二元决策指标：** 默认 single trigger validation positive recall 100%、FNR 0%；negative specificity 100%、FPR 0%。train 原始 positive recall 93.3%，negative specificity 100%；混合正例扩展为 10/10。shared router validation exact route 79/80（98.75%）；sanity 最新有效 case 约 57/60（95%），无双载。
- **Mixed / uncertain cases：** `p07_roadmap_planning` 原始 2/3，扩展 10/10。`natural-access-frontier` 原始偏移，独立 3-run 补跑只有 1 次正确，确认 P1。
- **Baseline、trace、token/time 和方差：** release+diagnostic 各 18 组 current/baseline；读取全部问题与最终消息。current 653335 tokens / 592724 ms；baseline 713772 / 722628 ms。自然前沿补跑 3 个 current/baseline pair。
- **Failure triage：** `natural-access-frontier` 是 Skill defect；`full_spec` 是 eval/runtime fixture defect；少量 route mismatch 是 Skill 边界 P2；baseline 大量通过是证据区分度问题。
- **Eval-driven 修改决策：** `accept` P1 行为 finding；`fix-eval-first` 用于 `full_spec`；本轮不修改 Skill。
- **发布仍缺少的证据：** 修复后的完整 release batch；`natural-access-frontier` 至少 10 次 exact frontier ≥0.9。

主 eval batch：`.tmp/agent-workflows/evals/plugin/ask-me/decision-grill/20260813T164651Z-full-review-20260814-materialization-3f043f6f/`

补跑证据：

- `.tmp/agent-workflows/evals/plugin/ask-me/decision-grill/20260813T201002Z-full-review-20260814-access-rerun-e9279b93/`
- `.tmp/agent-workflows/evals/plugin/ask-me/decision-grill/20260813T203259Z-full-review-20260814-trigger-rerun-f3175e7a/`

## 差量与沉积

- **上一版 P0/P1 关闭情况：** 本轮不是 delta；不以旧报告作为关闭合同。
- **受影响维度：** instruction_design、evals、triggering、problem_value。
- **直接回归：** 全部声明 suite 已执行；混合结果已补跑。
- **SKILL.md、pointer、branch 和资源变化：** 本轮无修改。
- **行为指标变化：** 不适用；这是当前源码的独立评审。
- **最小行为合同与复杂度结论变化：** 当前为 proportionate/minor。
- **新增规则及其替代内容：** 无。
- **沉积候选：** 没有 runtime 沉积；只需替换一条抽象前沿规则。
- **净变化：** neutral

## 最小改进路线

### 现在——发布阻断

1. 替换依赖前沿的抽象操作句，不增加阶段。
2. 以干净批次复跑全部 release-required suite，并对前沿 case 重复至少 10 次。

### 下一步——高价值质量改进

1. 修复 `full_spec` 只读 fixture 的完成条件。
2. 只有 shared router 的误路由仍重复时，局部改写 near-miss description。

### 以后——启发式、评测或产品/runtime 工作

1. 增加自然低提示 behavior case 和盲评。
2. 做三题上限、最终确认和最小合同的规则级 ablation。
3. 如需 Claude 行为兼容声明，运行 Claude 模型证据。

## 停止决定

现在停止评审。全部声明 case、必要 trace 和混合结果补跑已经完成，证据足以区分 Skill defect、eval fixture defect 和未知项。用户要求的是评审和发布报告，不是修复；在出现修复后的完整 release batch 前，不应继续向正文追加规则。
