# requirements-clarifier 完整评审

## 结论

- **Skill：** `requirements-clarifier`
- **模式：** full
- **方向：** at-risk
- **复杂度：** proportionate
- **可缩减程度：** minor
- **发布结论：** pass-after-fixes
- **加权总分：** 83.5
- **原始质量带：** strong
- **有效质量带：** strong
- **覆盖率：** 100%
- **置信度：** high（0.92）
- **一句话结论：** Skill 本体简洁、边界和方法正确；修复一个真实漏触发和一个不自洽的 behavior case 后可通过，但当前 eval 尚未证明它比插件质量门禁提供足够增量价值。

本报告是完整质量评审，不是 release 模式。它没有核对外部 current-check 来源；报告已作为 full 正式报告发布，但未登记到 Skill README。

用户已确认：开发阶段因更换发布渠道产生的版本变化是预期行为。该变化不属于本次 Skill 评审问题，不形成 finding、扣分或失败 gate。

## 评审合同

| 项目 | 从材料提取的结论 | 状态 |
| --- | --- | --- |
| 目标问题 | 在具体实施前，用最少问题补齐会改变结果、范围或验收的关键歧义 | known |
| 已观察失败 | 站内搜索正例只加载 1/3；一个 behavior case 的 prompt 与 expected outcome 不一致；一次负例 timeout，补跑未复现 | known |
| 成功标准 | 先查事实；对不确定项选择询问、默认或待验证；只问重要问题；无关键歧义后交还原任务 | known |
| 目标环境或客户端 | Codex project Skill；Claude 只验证确定性最终制品 | known |
| 范围外事项 | 可查事实、内部可逆选择、用户授权默认、完整规范、直接说明和协作决策访谈 | known |
| 相邻 Skill | `decision-grill` | known |
| 发布要求 | project/user materialization、trigger 和 behavior required targets | known |

## 发布门禁

| Gate ID | 状态 | 严重性 | Finding IDs | 证据 | 原因 |
| --- | --- | --- | --- | --- | --- |
| package-validity | pass | P0 | — | validator、source/project/user artifact | 名称、结构、引用和最终制品有效；开发渠道版本变化不在评审范围内 |
| critical-artifacts | pass | P0 | — | source/project/user digest | 文件存在，digest 匹配 |
| goal-alignment | pass | P0 | — | SKILL.md 与行为 trace | 没有目标或授权直接矛盾 |
| capability-validity | pass | P0 | — | 双平台 bundle test | 问题工具正确渲染 |
| safety-permissions | pass | P0 | — | strict eval 与 workspace diff | 澄清期间只读，未写 workspace |
| architecture-ownership | pass | P1 | — | 架构审计 | 没有自然语言 runtime 状态机 |
| release-evidence | fail | P1 | RC-F-002, RC-F-003 | 完整 EvaluationBundle 与补跑 | trigger full target 不完整，behavior required suite 失败 |

## 优点

- `SKILL.md` 只有约 504 tokens。处理方法集中，没有 reference sprawl。
- 询问、采用默认和待验证三路处理清楚。它把技术事实和用户产品意图区分开。
- validation 的 5 个负例都保持 0 Skill loads。完整规范、内部计划、稳定 bugfix、只读说明和明确内部函数没有误触发。
- 4 个 validation 正例各自 3/3 加载。只有站内搜索正例不稳定。
- current behavior 有 9/10 个 case 通过机械合同，且所有 workspace 保持不变。
- source、project 和 user 最终制品都有效。Codex 与 Claude 的确定性插件测试各 7/7 通过。
- 会话状态由 runtime 管理。Skill 不维护 timer、retry、pending 或跨 actor 协议。

## 必须修复的问题

| ID | 严重性 | 证据类型 | 维度 | 位置 | 受影响场景 | 证据 | 反证检查 | 正确 owner | 最小修改 | 验证方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RC-F-002 | P1 | observed, normative | triggering | trigger case `p08_search_scope` | 用户要求实现站内搜索，但搜索内容、权限或匹配范围未定 | 3 次中 1 次加载，1 次直接答，1 次不用 Skill 调用问题工具；load rate 0.333 | 其它 4 个正例 12/12；所有 validation 负例 0 loads | Skill | 只重写 description 第一条触发句，覆盖用户可见内容、权限或匹配范围未定的开放功能请求 | 完整 trigger validation 各跑 3 次；该 case 大于 0.5；严格负例仍为 0 |
| RC-F-003 | P1 | observed, structural | evals | behavior case `transparent-default` | 新列表页只有空状态惯例，核心范围仍缺失 | current 问字段、数据、操作、路由和状态；baseline 也判断需要补范围；expected 却要求不提问 | current 没有重问空状态本身；其它 9 个 current case 通过 | Eval | 明确其它列表需求均已完成，只留下空状态；或允许询问其它核心范围 | 重跑该 case 和完整 behavior suite，prompt 与 expected 必须描述同一任务 |

## 非阻断问题

| ID | 严重性 | 证据类型 | 维度 | 位置 | 观察 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| RC-F-004 | P2 | observed, heuristic | problem_value | 全部 10 个 behavior case | baseline 10/10，current 9/10；current 多约 26% tokens | 先用自然低提示任务和 minimal contract 做对照，再决定是否改 Skill |

## 未知项

| ID | 维度 | 描述 | 所需证据 |
| --- | --- | --- | --- |
| RC-U-001 | minimum_control | 没有隔离完整 Skill、插件 quality gate 和更小澄清合同 | 比较 quality-gate-only、minimal-contract 和 full-Skill |
| RC-U-002 | reliability | Claude 最终制品有效，但没有 Claude 模型 trigger 或问题行为结果 | 运行等价 Claude 模型 eval，或把行为兼容声明收窄到 Codex |

## 维度评分

| 维度 | 权重 | 分数 | 置信度 | 证据 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- | --- |
| 规范与包完整性 | 6 | 5.0 | high | validator、source/project/user final artifact | — | — | 包结构、名称、引用和最终制品有效 |
| 问题基础与实际价值 | 8 | 3.0 | medium | current 9/10；baseline 10/10 | RC-F-004 | — | 问题真实，但增量价值未证明 |
| 调用策略、触发条件与 Context Pointer | 10 | 3.5 | high | p08 1/3；负例 0 loads | RC-F-002 | — | 多数边界稳定，一个现实正例漏触发 |
| 范围、边界与组合性 | 8 | 5.0 | high | 两个 SKILL.md | — | — | 职责清楚且可组合 |
| 程序与完成边界 | 10 | 5.0 | high | 三路方法、stop 与 handoff | — | — | 方法清楚且可检查 |
| 最小充分控制与模型自由度 | 14 | 3.5 | medium | 最小控制审计 | — | RC-U-001 | 控制小，但与 quality gate 的重叠未知 |
| 信息层级、资源与渐进式披露 | 10 | 5.0 | high | 静态诊断 | — | — | runtime 内容集中且很小 |
| 职责归属与自然语言状态机风险 | 10 | 5.0 | high | 架构审计 | — | — | 状态由 runtime 管理 |
| 脚本与确定性自动化 | 7 | 5.0 | high | 双平台 plugin:test | — | — | 脚本决策正确 |
| 评测、验证与证据驱动迭代 | 9 | 2.5 | high | 完整 EvaluationBundle | RC-F-003 | — | 覆盖强，但一个核心 case 合同不自洽 |
| 可靠性、安全与兼容性 | 4 | 3.0 | medium | Codex eval、双平台 build/test | — | RC-U-002 | Claude 模型行为未知 |
| 剪枝、事实源与变更纪律 | 4 | 5.0 | high | 小正文、中央模板和独立 owner manifest | — | — | 无明显沉积或复制 |

## 调用与 Context Pointer 审计

| Pointer | 目标材料 | 触发 branch | 意图是否前置 | 是否重复同义 branch | 是否重复正文身份 | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| frontmatter description | `requirements-clarifier` | 实施或修改，且只读检查后仍有结果级关键歧义 | 是 | 否 | 少量 | 4 个正例稳定，p08 1/3 | 只扩充一类开放功能范围信号 |
| description / 正文中的 `decision-grill` | 相邻 Skill | 用户明确要求逐轮访谈并形成共享理解 | 是 | 否 | 否 | 双 Skill router 多数稳定 | 保留 |
| plugin quality gate | 是否需要加载 RC | 非平凡实施前检查，多种合理理解会影响结果 | 是 | 否 | 部分 | baseline 行为很强 | 作为 minimal ablation 的独立变体 |
| `agents/openai.yaml` default prompt | 显式入口 | 用户明确使用 `$requirements-clarifier` | 是 | 否 | 否 | 显式 trigger 3/3 | 保留 |

## 最小有效控制审计

### 最小行为合同

1. 只在具体实施或修改存在结果级关键歧义时激活。
2. 先查事实、惯例和已有决定；可查或已授权默认不再问。
3. 对剩余项选择询问、默认或待验证；技术事实不交给用户拍板。
4. 先问上游；互相独立时一轮最多三题；选项准确时用问题工具。
5. 没有关键歧义时停止，并交还已确认、关键默认和待验证项。
6. 澄清期间不修改文件、不做原型、不开始实施。

### 控制面

| Signal | Count / observation | Risk |
| --- | ---: | --- |
| Mandatory stages | 3：检查、处理不确定项、结束 | low |
| Hard gates | 0；使用结果级成本阈值 | low |
| Fixed intermediate artifacts | 0 | low |
| Prohibitions | 3 个主要不变量 | low |
| Conditional branches | 2 个静态信号；正文有三路选择 | low |
| Fixed output fields | 3 个按需字段，空项可省略 | low |

### 必要性映射与简化候选

| 当前行为块 | 改变的行为 | 依据 | 当前控制类型 | 模型默认能否处理 | 处理建议 | 删除或放宽风险 |
| --- | --- | --- | --- | ---: | --- | --- |
| 先读事实 | 防止把事实问题交给用户 | 目标、trigger 负例 | invariant | 不稳定 | keep-invariant | 重复或错误提问 |
| 询问/默认/待验证三路 | 分离产品意图和技术事实 | 核心方法、behavior | invariant | 部分 | keep-invariant | 让用户替技术可行性拍板 |
| 重要性与返工阈值 | 只问值得问的问题 | 核心目标 | invariant | 不稳定 | keep-invariant | 过度提问 |
| 多项小歧义合并 | 防止组合影响被忽略 | trigger 与 behavior | default | 不稳定 | keep-default | 成品形态被静默决定 |
| 上游优先、最多三题 | 控制顺序和负担 | behavior 与 heuristic | default | 部分 | needs-ablation | 问题顺序或负担变差 |
| stop 与交接 | 防止澄清无限延长 | 核心目标 | invariant | 不稳定 | keep-invariant | 无法返回原任务 |
| 澄清期间只读 | 防止未授权实现 | 安全边界 | invariant | 不稳定 | keep-invariant | 澄清变成实施 |

复杂度结论是 `proportionate`。正文不长；主要未知是它与 always-loaded quality gate 的边际重叠。

## 信息层级图

| 内容 | 类型 | 适用 branch | 当前位置 | 是否每次需要 | 到达 pointer 或环境事实源 | 最小控制结论 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| 激活和 near-miss | in-file-reference | 每次发现 | description | 是 | Skill catalog | keep-invariant | 只改一个漏触发类别 |
| 处理不确定项 | in-file-step | 每次澄清 | SKILL.md | 是 | 正文 | keep-invariant | 保留 |
| 提问策略 | in-file-step | 有值得问的问题 | SKILL.md | 否 | 正文与 runtime tool | keep-default | 保留 |
| 结束和交接 | in-file-step | 无关键歧义或用户停止 | SKILL.md | 是 | 正文 | keep-invariant | 保留 |
| 相邻 DG 边界 | in-file-reference | 明确协作访谈 | description 与正文 | 是 | `decision-grill` | keep-invariant | 保留 |
| 对话、代码、配置和文档 | environment-lookup | 有材料时 | 环境 | 否 | 仓库与对话 | keep-invariant | 不缓存 |
| eval 语料和 trace | disclosed-reference | 作者评测 | `evals/` 与 `.tmp` | 否 | owner manifest | 不进入 runtime | 保持隔离 |

## 完成边界审计

| 步骤或规则集 | 当前标准 | 清楚 | 可检查 | 要求充分 | 覆盖完整 | 提前完成风险 | 建议 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 只读检查 | 已说明或能查到的事实直接采用 | 是 | 是 | 是 | 是 | low | 保留 |
| 三路处理 | 每个剩余不确定项归入询问、默认或待验证 | 是 | 是 | 是 | 是 | low | 保留 |
| 提问 | 上游优先；收到回答后重查 | 是 | 是 | 是 | 是 | low | 保留 |
| 停止 | 没有值得继续问的关键歧义 | 是 | 是 | 是 | 是 | low | 保留 |
| 交接 | 按需列已确认、关键默认和待验证或未解决 | 是 | 是 | 是 | 是 | low | 保留 |

## 架构与职责归属

- **Skill 负责的策略：** 发现时机、不确定项分类、提问阈值、停止和交接。
- **Schema 或客户端负责的事实：** 问题结构、选项、question id 和用户答复。
- **Runtime 负责的状态：** 当前会话、等待和回复顺序。
- **脚本候选：** 没有。关键歧义和返工成本需要语义判断。
- **仅属于 role 的约束：** 没有独立 role。
- **仅属于 eval 或 issue 的问题：** `transparent-default` 合同、timeout 方差、Claude 模型覆盖和增量价值语料。
- **自然语言状态机风险：** low

## 脚本与资源

- **已有脚本或正确省略：** agent-facing script 正确省略；插件合同和 fixture 使用 Node 脚本。
- **接口、依赖和安全质量：** plugin:test 双平台通过；fixture 只写隔离 workspace。
- **模型仍在重复的确定性逻辑：** 没有明显候选。
- **Reference 和 asset 可达性：** runtime 无外部 reference；eval owner manifest 一层可达。
- **重复：** quality gate 与 Skill description 有一部分发现规则重叠。这是运行组合，不是文件复制错误，但需要 ablation。
- **Scattering 与 co-location：** 核心流程在一个文件；插件 gate 独立承担发现前检查。
- **不必要缓存的环境事实：** 没有。
- **过期或孤立资源：** 没有静态孤立资源。

## 评测与证据

- **Trigger eval 与触发率：** 完整 validation 启动 30 次运行。4 个正例 12/12；`p08_search_scope` 1/3；5 个负例 0/15 loads。
- **Timeout：** `n07_internal_planning` 有 1/3 timeout。相同 batch 的单次补跑通过，0 Skill loads，timeout 未复现。它保留为方差 provenance，不形成 Skill finding。
- **Behavior 或 regression eval：** 10 个 case，current/baseline 共 20 次；current 9/10，baseline 10/10。
- **Runtime trace：** 已读取全部 case 的问题、最终消息和机械状态；对失败 case 读取问题工具事件。
- **基线：** without owner Skill；保留插件 quality gate 和相邻 `decision-grill`。
- **Ablation 或 no-op 证据：** 有 no-owner baseline；没有 quality-gate-only、minimal-Skill 和规则级三方对照。
- **Token、时间和方差成本：** current 389309 tokens / 221301 ms；baseline 308981 tokens / 210853 ms。current 多约 26% tokens 和 5% wall time。
- **发布仍缺少的证据：** 修复后的完整 trigger target 和 behavior pass；Claude 模型行为仍是兼容性 unknown。

Eval batch：`.tmp/agent-workflows/evals/plugin/ask-me/requirements-clarifier/20260812T173052Z-full-review-20260813-20594630/`

## 最小改进路线

### 现在——发布阻断

1. 修复 `transparent-default` 的 prompt/expected 合同，不要为不必要的 Skill 规则找补。
2. 只重写 description 第一条触发句，并复跑完整 trigger validation。

### 下一步——高价值质量改进

1. 用 2–3 个自然低提示任务替换强提示 behavior prompt。
2. 比较 quality-gate-only、minimal contract 和 full Skill；只有证明增量后才保留相应强制规则。

### 以后——启发式、评测或产品/runtime 工作

1. 记录 trigger 负例的 token 和 timeout 方差，避免完整 eval 被长时间实施尝试拖慢。
2. 若要声称 Claude 行为兼容，运行 Claude 模型证据。

## 停止决定

现在停止继续修改 Skill。用户要求的是评审和完整 eval，不是修复。现有证据已经证明一个真实漏触发，也证明一个 behavior 失败属于 eval 合同。下一轮应先出现修复后的 trigger 和 behavior 结果；在这些新证据出现前，不应向 `SKILL.md` 追加更多流程或例外。
