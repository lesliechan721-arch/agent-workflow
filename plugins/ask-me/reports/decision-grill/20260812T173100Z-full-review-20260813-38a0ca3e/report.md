# decision-grill 完整评审

## 结论

- **Skill：** `decision-grill`
- **模式：** full
- **方向：** at-risk
- **复杂度：** proportionate
- **可缩减程度：** minor
- **发布结论：** pass-after-fixes
- **加权总分：** 84.5
- **原始质量带：** strong
- **有效质量带：** strong
- **覆盖率：** 100%
- **置信度：** high（0.92）
- **一句话结论：** Skill 本体小而清楚，单 Skill 触发和大部分访谈行为稳定；修复一个关键双 Skill 路由边界和 baseline 判定合同后可通过。

本报告是完整质量评审，不是 release 模式。它没有核对外部 current-check 来源；报告已作为 full 正式报告发布，但未登记到 Skill README。

用户已确认：开发阶段因更换发布渠道产生的版本变化是预期行为。该变化不属于本次 Skill 评审问题，不形成 finding、扣分或失败 gate。

## 评审合同

| 项目 | 从材料提取的结论 | 状态 |
| --- | --- | --- |
| 目标问题 | 对计划、决策或想法做逐轮访谈，形成共享理解 | known |
| 已观察失败 | approved-plan 实施缺口精确路由 8/10；一个 current 行为未进入问题工具；baseline 差异被计为 owner 失败 | known |
| 成功标准 | 正确区分直接回答、局部需求澄清和协作访谈；按依赖前沿提问；保存并确认决策记录 | known |
| 目标环境或客户端 | Codex project Skill；Claude 只验证确定性最终制品 | known |
| 范围外事项 | 技术说明、一次性比较或评审、直接推荐、agent 内部计划和普通局部实施歧义 | known |
| 相邻 Skill | `requirements-clarifier` | known |
| 发布要求 | project/user materialization、trigger、exact router 和 behavior required targets | known |

## 发布门禁

| Gate ID | 状态 | 严重性 | Finding IDs | 证据 | 原因 |
| --- | --- | --- | --- | --- | --- |
| package-validity | pass | P0 | — | validator、source/project/user artifact | 名称、结构、引用和最终制品有效；开发渠道版本变化不在评审范围内 |
| critical-artifacts | pass | P0 | — | source/project/user digest | 文件存在，digest 匹配 |
| goal-alignment | pass | P0 | — | SKILL.md 与行为 trace | 没有目标或授权直接矛盾 |
| capability-validity | pass | P0 | — | 双平台 bundle test | 问题工具正确渲染 |
| safety-permissions | pass | P0 | — | strict eval 与 workspace diff | 确认前只读，未写 workspace |
| architecture-ownership | pass | P1 | — | 架构审计 | 没有自然语言 runtime 状态机 |
| release-evidence | fail | P1 | DG-F-002, DG-F-003 | 完整 EvaluationBundle | exact router 和 behavior required suite 失败 |

## 优点

- `SKILL.md` 只有约 689 tokens。规则集中，没有 runtime reference sprawl。
- 单 Skill trigger validation 的 10 个 case 全部通过。共 30 次运行。
- 7 个双 Skill router case 各自 10/10 通过。直接说明、一次性评审、局部实施澄清和显式访谈边界多数稳定。
- current behavior 有 14/15 个 case 通过机械合同。`low-prompt-frontier` 正确完成两轮依赖前沿；baseline 没有做到。
- current behavior 比 baseline 少约 4% tokens，也少约 4% wall time。
- source、project 和 user 最终制品都有效。Codex 与 Claude 的确定性插件测试各 7/7 通过。
- 会话阶段由 runtime 维护。Skill 只定义决策策略、停止条件和记录要求。

## 必须修复的问题

| ID | 严重性 | 证据类型 | 维度 | 位置 | 受影响场景 | 证据 | 反证检查 | 正确 owner | 最小修改 | 验证方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DG-F-002 | P1 | observed, normative | triggering | router case `approved_plan_implementation_gap` | 已批准计划仍有会改变验收的局部兼容期缺口 | 10 次中 8 次只读 RC，1 次不读 Skill，1 次读取两个 Skill；exact route 0.8，小于 0.9 | 单 Skill trigger 10/10；其它 7 个 router case 全过 | Skill | 只改两个 description 的交叉边界句，明确该场景只属于 RC | 全部 8 个 router case 各跑 10 次；每个不低于 0.9；双载为 0 |
| DG-F-003 | P1 | observed, structural, normative | evals | behavior case `low-prompt-frontier` | Skill 产生了 baseline 没有的多轮工具行为 | current 消费两步回复并通过；baseline 没提问，留下两步回复；suite 因 baseline 失败 | `user-decision-not-self-answer` 是 current 也失败的独立问题 | Project | 支持 variant-specific 回复期望，或把预期的 baseline 缺失保存为对照证据而不是 owner 失败 | current 仍通过，baseline 差异仍可见，suite 不因预期差异失败 |

## 非阻断问题

| ID | 严重性 | 证据类型 | 维度 | 位置 | 观察 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| DG-F-004 | P2 | observed | instruction_design | behavior case `user-decision-not-self-answer` | current 已读 Skill，但用普通文本问宽泛优先级，没有调用问题工具；用户的延后回复未被消费 | 先把该 case 跑 3 次；若重复，替换现有工具规则，不追加新阶段 |
| DG-F-005 | P2 | observed, heuristic | problem_value | 15 个 behavior case | baseline 通过 13/15；多数 prompt 已直接写出目标程序 | 用 2–3 个自然低提示任务替换强提示任务，先提高区分度 |

## 未知项

| ID | 维度 | 描述 | 所需证据 |
| --- | --- | --- | --- |
| DG-U-001 | minimum_control | 没有隔离“三题上限”、最终确认门禁和完整正文的规则级 ablation | 比较最小合同、当前 Skill 和删除单项规则的变体 |
| DG-U-002 | reliability | Claude 最终制品有效，但没有 Claude 模型 trigger 或多轮访谈结果 | 运行等价 Claude 模型 eval，或把行为兼容声明收窄到 Codex |

## 维度评分

| 维度 | 权重 | 分数 | 置信度 | 证据 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- | --- |
| 规范与包完整性 | 6 | 5.0 | high | validator、source/project/user final artifact | — | — | 包结构、名称、引用和最终制品有效 |
| 问题基础与实际价值 | 8 | 4.0 | medium | current 14/15；baseline 13/15 | DG-F-005 | — | 有低提示增量证据，但覆盖窄 |
| 调用策略、触发条件与 Context Pointer | 10 | 3.5 | high | trigger 10/10；router 7/8 | DG-F-002 | — | 单 Skill 稳定，一个组合边界失败 |
| 范围、边界与组合性 | 8 | 5.0 | high | 两个 SKILL.md | — | — | 职责清楚且可组合 |
| 程序与完成边界 | 10 | 4.0 | high | behavior trace | DG-F-004 | — | 方法清楚，一个工具路径不稳定 |
| 最小充分控制与模型自由度 | 14 | 4.0 | medium | 最小控制审计 | — | DG-U-001 | 控制适度，缺规则级 ablation |
| 信息层级、资源与渐进式披露 | 10 | 5.0 | high | 静态诊断 | — | — | runtime 内容集中且很小 |
| 职责归属与自然语言状态机风险 | 10 | 5.0 | high | 架构审计 | — | — | 状态由 runtime 管理 |
| 脚本与确定性自动化 | 7 | 5.0 | high | 双平台 plugin:test | — | — | 脚本决策正确 |
| 评测、验证与证据驱动迭代 | 9 | 2.5 | high | 完整 EvaluationBundle | DG-F-003 | — | 覆盖强，但对照合同会制造失败 |
| 可靠性、安全与兼容性 | 4 | 3.0 | medium | Codex eval、双平台 build/test | — | DG-U-002 | Claude 模型行为未知 |
| 剪枝、事实源与变更纪律 | 4 | 5.0 | high | 小正文、中央模板和独立 owner manifest | — | — | 无明显沉积或复制 |

## 调用与 Context Pointer 审计

| Pointer | 目标材料 | 触发 branch | 意图是否前置 | 是否重复同义 branch | 是否重复正文身份 | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| frontmatter description | `decision-grill` | 明确逐轮追问、共同推演、外层访谈阶段 | 是 | 否 | 少量 | trigger 10/10 | 保留主体，只收紧实施缺口交叉句 |
| description / 正文中的 `requirements-clarifier` | 相邻 Skill | 具体实施只缺局部关键歧义 | 是 | 否 | 否 | router 相关 case 7/8 | 用更排他的 approved-plan 实施缺口措辞 |
| `agents/openai.yaml` default prompt | 显式入口 | 用户明确使用 `$decision-grill` | 是 | 否 | 否 | 显式 trigger 通过 | 保留 |

## 最小有效控制审计

### 最小行为合同

1. 只在任务需要逐轮协作决定时激活；直接分析和内部计划不激活。
2. 先查事实和旧决定；区分事实、用户取舍和待验证事项。
3. 建立依赖前沿；先问上游；一轮最多三项互相独立的问题。
4. 无冲突、弱依据或重大未知后果时，不重开已有决定。
5. 重要分支都已决定、委托、待验证或明确延后时停止。
6. 保存决定、委托、待验证、延后风险和未解决项。
7. 除非用户放弃确认，否则确认记录后才交接；确认前不实施。

### 控制面

| Signal | Count / observation | Risk |
| --- | ---: | --- |
| Mandatory stages | 3：建立树、推进前沿、收尾 | low |
| Hard gates | 1：最终记录确认 | low |
| Fixed intermediate artifacts | 0；决策树是思考结构，不要求文件 | low |
| Prohibitions | 4 个主要不变量 | low |
| Conditional branches | 5 个静态信号 | low |
| Fixed output fields | 6 个按需字段，空项可省略 | low |

### 必要性映射与简化候选

| 当前行为块 | 改变的行为 | 依据 | 当前控制类型 | 模型默认能否处理 | 处理建议 | 删除或放宽风险 |
| --- | --- | --- | --- | ---: | --- | --- |
| 先读事实和已有决定 | 防止向用户问可查事实 | 目标与 behavior case | invariant | 不稳定 | keep-invariant | 产生重复问题 |
| 拆成重要决定 | 防止一次性浅问 | 目标 | default | 部分 | keep-default | 访谈缺主干 |
| 依赖前沿 | 防止先问下游 | 多轮 observed case | invariant | 不稳定 | keep-invariant | 问题顺序错误 |
| 每轮最多三题 | 限制认知负担 | heuristic 与 eval | default | 部分 | needs-ablation | 可能增加用户负担 |
| 推荐必须有依据 | 防止把偏好包装成决定 | 目标与 behavior | invariant | 不稳定 | keep-invariant | 侵占用户决定 |
| 停止和按需记录 | 防止穷举或静默遗漏 | behavior regression | invariant | 不稳定 | keep-invariant | 无法稳定交接 |
| 最终确认 | 建立共享理解 | 核心目标 | invariant | 不稳定 | keep-invariant | 记录可能未获认可 |
| 确认前不实施 | 保留用户控制 | 安全与范围 | invariant | 不稳定 | keep-invariant | 访谈变成未授权实施 |

复杂度结论是 `proportionate`。只存在局部可简化或需要 ablation 的控制，没有完整 runbook 或自然语言状态机。

## 信息层级图

| 内容 | 类型 | 适用 branch | 当前位置 | 是否每次需要 | 到达 pointer 或环境事实源 | 最小控制结论 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| 激活和 near-miss | in-file-reference | 每次发现 | description | 是 | Skill catalog | keep-invariant | 保留 |
| 建立决策树 | in-file-step | 访谈开始 | SKILL.md | 是 | 正文 | keep-default | 保留 |
| 当前前沿规则 | in-file-step | 每轮 | SKILL.md | 是 | 正文 | keep-invariant | 保留 |
| 收尾和记录 | in-file-step | 完成分支 | SKILL.md | 是 | 正文 | keep-invariant | 保留 |
| 相邻 RC 边界 | in-file-reference | 实施语境 | description 与正文 | 是 | `requirements-clarifier` | keep-invariant | 只重写交叉句 |
| 代码、文档和已有决定 | environment-lookup | 有材料时 | 仓库与对话 | 否 | 环境 | keep-invariant | 不缓存 |
| eval 语料和 trace | disclosed-reference | 作者评测 | `evals/` 与 `.tmp` | 否 | owner manifest | 不进入 runtime | 保持隔离 |

## 完成边界审计

| 步骤或规则集 | 当前标准 | 清楚 | 可检查 | 要求充分 | 覆盖完整 | 提前完成风险 | 建议 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 事实检查 | 已知事实采用，可查事实自行确认 | 是 | 是 | 是 | 是 | low | 保留 |
| 当前前沿 | 前置决定明确后才问；收到回答后重算 | 是 | 是 | 是 | 是 | low | 保留 |
| 停止 | 重要分支均有决定、委托、待验证或延后风险 | 是 | 是 | 是 | 是 | low | 保留 |
| 决策记录 | 按需保留 owner、期限、条件和未解决项 | 是 | 是 | 是 | 是 | low | 保留 |
| 最终确认 | 用户确认或明确跳过后交接 | 是 | 是 | 是 | 是 | low | 保留 |

## 架构与职责归属

- **Skill 负责的策略：** 发现时机、事实与取舍分离、依赖前沿、停止和记录。
- **Schema 或客户端负责的事实：** 问题结构、选项、返回 question id 和用户答复。
- **Runtime 负责的状态：** 当前会话、等待、回复顺序和工具生命周期。
- **脚本候选：** 没有。决策树和记录需要语义判断，不适合脚本化。
- **仅属于 role 的约束：** 没有独立 role。
- **仅属于 eval 或 issue 的问题：** baseline 对照判定、case prompt 强度和 Claude 模型覆盖。
- **自然语言状态机风险：** low

## 脚本与资源

- **已有脚本或正确省略：** agent-facing script 正确省略；插件合同和 fixture 使用 Node 脚本。
- **接口、依赖和安全质量：** plugin:test 双平台通过；fixture 只写隔离 workspace。
- **模型仍在重复的确定性逻辑：** 没有明显候选。
- **Reference 和 asset 可达性：** runtime 无外部 reference；eval owner manifest 一层可达。
- **重复：** description 与正文有少量相邻 Skill 边界重复，用途不同。
- **Scattering 与 co-location：** 核心流程都在一个文件。
- **不必要缓存的环境事实：** 没有。
- **过期或孤立资源：** 没有静态孤立资源；旧正式 delta 报告范围已清楚标注。

## 评测与证据

- **Trigger eval 与触发率：** 单 Skill 10/10 case 通过，30 次运行；router 7/8 case 通过，80 次运行。失败 case 的 exact route 是 8/10。
- **Behavior 或 regression eval：** 15 个 case，current/baseline 共 30 次；current 14/15，baseline 13/15。
- **Runtime trace：** 已读取全部 case 的问题、最终消息、机械状态；对失败 case 读取工具和 Skill 加载事件。
- **基线：** without owner Skill；保留相邻 `requirements-clarifier`。
- **Ablation 或 no-op 证据：** 有 no-owner baseline；没有规则级或 minimal-Skill ablation。
- **Token、时间和方差成本：** current 480825 tokens / 302535 ms；baseline 501735 tokens / 315723 ms。
- **发布仍缺少的证据：** 修复后 exact router 和 behavior release pass；Claude 模型行为不属于当前 Codex release evidence，但仍是兼容性 unknown。

Eval batch：`.tmp/agent-workflows/evals/plugin/ask-me/decision-grill/20260812T173100Z-full-review-20260813-38a0ca3e/`

## 最小改进路线

### 现在——发布阻断

1. 修复 baseline 对照判定，不能把已证明的 owner Skill 增量当作 owner 失败。
2. 只重写交叉 description 边界，并复跑完整 8 × 10 router validation。

### 下一步——高价值质量改进

1. 把 `user-decision-not-self-answer` 跑 3 次。只有重复失败时才替换现有问题工具规则。
2. 用 2–3 个自然低提示任务替换强提示 behavior prompt。

### 以后——启发式、评测或产品/runtime 工作

1. 做最小合同和规则级 ablation。
2. 若要声称 Claude 行为兼容，运行 Claude 模型证据。

## 停止决定

现在停止继续修改 Skill。用户要求的是评审和完整 eval，不是修复。现有证据已经区分 Skill 问题和 eval framework 问题。下一轮应先出现修复后的 exact-router 和 behavior 结果；在这些新证据出现前，不应继续向 `SKILL.md` 追加规则。
