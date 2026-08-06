# Scoring Model

本文件定义统一权重、评分锚点、证据置信度和发布门禁。任何带分数的评审都必须使用它。

## 维度与权重

| ID | 维度 | 权重 |
| --- | --- | ---: |
| `specification` | 规范与包完整性 | 8 |
| `problem_value` | 问题基础与实际价值 | 8 |
| `triggering` | 触发条件与 description | 12 |
| `scope_composition` | 范围、边界与组合性 | 10 |
| `instruction_design` | 指令设计与控制校准 | 10 |
| `context_disclosure` | 上下文效率与渐进式披露 | 10 |
| `architecture` | 职责归属与自然语言状态机风险 | 10 |
| `scripts` | 脚本与确定性自动化 | 8 |
| `resources` | references、assets 与资源组织 | 6 |
| `evals` | 评测、验证与证据驱动迭代 | 10 |
| `reliability` | 可靠性、安全与兼容性 | 4 |
| `maintainability` | 可维护性与变更纪律 | 4 |

总权重为 100。

## 通用 0–5 分锚点

- **5 — 优秀**：设计正确、材料完整、无实质缺陷；关键判断有 observed/documented 证据，或正确证明该组件无需存在。
- **4 — 良好**：主体可靠，只有局部清晰度、覆盖或验证缺口，不影响核心目标。
- **3 — 合格**：能工作，但存在明显改进空间、证据不足或若干会反复降低质量的问题。
- **2 — 较弱**：有明确缺陷，目标场景中容易失败；需要实质修改。
- **1 — 很差**：维度大部分缺失、错误或与目标不一致。
- **0 — 无效**：规范无效、直接矛盾、关键机制不可执行，或该维度完全破坏 Skill 目标。

允许 0.5 步进。不要使用伪精确的小数。

## 缺失组件的评分

“不存在”与“未提供给 reviewer”必须区分：

- 组件不需要且被正确省略：可得 4–5 分。
- 组件应当存在但缺失：按影响扣分。
- 用户未提供、无法判断：该维度设为 `null`，降低评审覆盖率，不假定为 0，也不假定为 5。

## 分数计算

`validate_scorecard.mjs` 使用：

`weighted_score = Σ(weight × score / 5) ÷ assessed_weight × 100`

同时报告：

- **coverage**：已评估维度权重占 100 的比例。
- **confidence index**：high=1.0、medium=0.7、low=0.4、unknown=0，按已评估权重加权。
- **quality band**：
  - 90–100：excellent
  - 80–89.5：strong
  - 70–79.5：adequate
  - 60–69.5：weak
  - <60：poor

## 证据置信度

- **high**：有真实执行结果，或规范/源码与被审内容共同直接支持。
- **medium**：有直接静态材料，但没有行为验证。
- **low**：主要依赖推理、启发式或不完整材料。
- **unknown**：缺失必要材料。

质量分和置信度不能互相替代。

## 证据上限提示

以下不是自动判错，但分数超过上限时必须在报告中解释：

- 没有 realistic trigger eval 结果时，`triggering` 通常不高于 3。
- 有脚本但未做安全静态检查或 `--help`/样例运行时，`scripts` 通常不高于 3。
- 没有任何 trigger、behavior、regression 或 trace 证据时，`evals` 通常不高于 2。
- 声明具体产品、版本、权限或外部依赖兼容性却未验证时，`reliability` 通常不高于 3。
- delta 评审没有上一版或变更记录时，`maintainability` 通常不高于 3。

## 发布门禁

分数不能覆盖以下门禁：

1. **package-validity**：frontmatter、name/目录、必需结构有效。
2. **critical-artifacts**：被核心流程引用的文件存在且可用。
3. **goal-alignment**：Skill 没有与其目标、授权或范围直接矛盾。
4. **capability-validity**：核心流程不依赖不存在、未公开或被禁止的能力。
5. **safety-permissions**：不会静默越权、泄露敏感数据或执行不受控副作用。
6. **architecture-ownership**：核心正确性不依赖无法可靠维护的自然语言运行时状态机。
7. **release-evidence**：release 模式具备足以支持发布结论的触发和行为证据。

门禁状态为 `pass`、`fail`、`unknown` 或 `not_applicable`。`fail` 必须给出严重性与原因；release 模式存在关键 `unknown` 时结论为 provisional。

## Finding 严重性

- **P0**：发布硬阻断；规范无效、关键能力不存在、安全边界破坏或核心目标直接矛盾。
- **P1**：有 observed/documented 证据表明会在目标场景中造成实质、重复失败。
- **P2**：有限范围的质量、维护或测试问题，不阻断核心目标。
- **Advisory**：推演风险、未来兼容性或产品/runtime 建议，默认不要求增加 Skill 文本。

纯 `inferred` finding 除直接逻辑矛盾外不得高于 P2。

## 发布结论

脚本按以下顺序计算：

1. 任一 P0 gate/finding → `fail`。
2. 任一 P1 gate/finding → `pass-after-fixes`。
3. release 模式 coverage 不足或关键 gate 为 unknown → `provisional`。
4. 无阻断时：score ≥85 → `pass`；70–84.5 → `pass-after-fixes`；<70 → `redesign`。

方向判断独立于发布结论：`aligned`、`at-risk` 或 `drifted`。
