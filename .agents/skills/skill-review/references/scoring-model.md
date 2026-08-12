# Scoring Model

任何维度评分都使用本文件和 `scripts/validate_scorecard.mjs`。quick/delta 可以评价局部维度，但不计算加权总分或 raw/effective quality band。

## 维度与权重

| ID | 维度 | 权重 |
| --- | --- | ---: |
| `specification` | 规范与包完整性 | 6 |
| `problem_value` | 问题基础与实际价值 | 8 |
| `triggering` | 调用策略、触发条件与 Context Pointer | 10 |
| `scope_composition` | 范围、边界与组合性 | 8 |
| `instruction_design` | 程序与完成边界 | 10 |
| `minimum_control` | 最小充分控制与模型自由度 | 14 |
| `context_disclosure` | 信息层级、资源与渐进式披露 | 10 |
| `architecture` | 职责归属与自然语言状态机风险 | 10 |
| `scripts` | 脚本与确定性自动化 | 7 |
| `evals` | 评测、验证与证据驱动迭代 | 9 |
| `reliability` | 可靠性、安全与兼容性 | 4 |
| `maintainability` | 剪枝、事实源与变更纪律 | 4 |

总权重为 100。

## 0–5 分锚点

- **5 — 优秀**：设计正确、材料完整、无实质缺陷；关键判断有行为或权威证据，或正确证明组件无需存在。
- **4 — 良好**：主体可靠，只有局部清晰度、覆盖或验证缺口。
- **3 — 合格**：能工作，但存在明显改进空间、证据不足或反复降低质量的问题。
- **2 — 较弱**：目标场景中容易失败，需要实质修改。
- **1 — 很差**：该维度大部分缺失、错误或与目标不一致。
- **0 — 无效**：直接矛盾、关键机制不可执行，或完全破坏 Skill 目标。

允许 0.5 步进。组件应当不存在且被正确省略时可得 4–5；用户未提供、无法判断时设为 `null`，降低 coverage。

## 证据权威

| 类型 | 含义 | 可单独支持 P0/P1 |
| --- | --- | ---: |
| `observed` | trace、复现、测试、用户确认失败 | 是 |
| `normative` | 当前官方规范、目标 runtime/schema、项目硬规则、用户明确要求 | 是 |
| `structural` | 被审包内直接可验证的断裂、无效配置、矛盾或不可执行关系 | 是 |
| `heuristic` | 第三方设计原则、经验模式、可读性判断 | 否 |
| `inferred` | 未验证的未来风险或静态推演 | 否 |

Finding 可以包含多个证据类型。P0/P1 至少包含一个 `observed`、`normative` 或 `structural`；若所谓“直接矛盾”存在，应标为 `structural`，而不是提升纯推演。

## 置信度

- **high**：行为结果，或权威来源与被审内容共同直接支持。
- **medium**：静态材料完整，但缺少运行验证。
- **low**：主要是 heuristic/inference，或材料不完整。
- **unknown**：缺少必要材料。

质量分、coverage 和 confidence 相互独立。

## 计算

`weighted_score = Σ(weight × score / 5) ÷ assessed_weight × 100`

只有 full/release 且 12 个维度全部完成时计算 `weighted_score` 和 raw/effective quality band。quick/delta 的这些字段为 `null`。

同时报告：

- coverage：已评估权重占 100 的比例。
- confidence index：high=1.0、medium=0.7、low=0.4、unknown=0，按已评估权重加权。
- raw quality band：90–100 excellent；80–89.5 strong；70–79.5 adequate；60–69.5 weak；<60 poor。
- effective quality band：先使用 raw quality band，再应用复杂度上限；`over-specified` 不高于 `adequate`，`over-engineered` 不高于 `weak`。

总分和 raw quality band 只用于定位薄弱维度、比较同一 Skill 的版本和观察趋势。报告以 effective quality band 为总体质量结论。它们不用于直接比较用途或结构不同的 Skill。

## 复杂度结论

full/release 必须在评分前完成最小有效控制审计，并给出独立结论：

- `minimal`：强制规则均有明确依据，无法在保留核心行为时实质缩短。
- `proportionate`：控制强度与任务脆弱度匹配，只有局部可选简化。
- `over-specified`：主体正确，但多个 always-loaded 强制规则、阶段或 artifact 缺少足够依据，合理策略空间受到限制。
- `over-engineered`：Skill 接近完整 runbook 或人工 SOP，控制结构替代了模型应承担的领域判断。

同时报告 reducibility：`almost-none`、`minor`、`significant`、`core-plus-reference` 或 `redesign`。`minimal` 和 `proportionate` 要求 `minimum_control` 高于 3；`over-specified` 必须关联该维度 finding，方向不能为 `aligned`；`over-engineered` 必须关联该维度 finding，方向为 `drifted`。缺少 ablation 时可以使用 `needs-ablation`；当多个强制规则的必要性仍未知时，不能把最小控制维度评为 4–5。

## 证据上限提示

脚本不自动改分，但下列高分必须解释：

- 没有 trigger eval 结果，`triggering` 通常不高于 3。
- 没有 pointer audit，`triggering` 通常不高于 4。
- 没有 completion-boundary audit，`instruction_design` 通常不高于 4。
- full/release 没有 minimum-effective-control audit 时 scorecard 无效；quick/delta 没有该审计时，`minimum_control` 通常不高于 3。
- 没有 information-hierarchy map，`context_disclosure` 通常不高于 4。
- 有脚本但未做安全静态检查、`--help` 或样例运行，`scripts` 通常不高于 3。
- 没有 trigger、behavior、regression、ablation 或 trace 证据，`evals` 通常不高于 2。
- 有具体兼容性声明但未验证，`reliability` 通常不高于 3。
- delta 模式没有上一版，`maintainability` 通常不高于 3。

## 发布门禁

1. `package-validity`：frontmatter、name/目录和必需结构有效。
2. `critical-artifacts`：核心流程引用的文件存在且可用。
3. `goal-alignment`：Skill 没有与目标、授权或范围直接矛盾。
4. `capability-validity`：核心流程不依赖不存在、未公开或被禁止的能力。
5. `safety-permissions`：不会静默越权、泄露敏感数据或执行不受控副作用。
6. `architecture-ownership`：核心正确性不依赖无法可靠维护的自然语言 runtime 状态机。
7. `release-evidence`：release 模式具备足以支持发布结论的触发和行为证据。

门禁状态：`pass`、`fail`、`unknown`、`not_applicable`。高分不能覆盖门禁失败。

## Finding 严重性

- **P0**：发布硬阻断；规范无效、关键能力不存在、安全边界破坏或核心目标直接矛盾。
- **P1**：有 observed/normative/structural 证据表明会在目标场景造成实质且重复的失败。
- **P2**：有限范围的质量、维护、证据或测试问题。
- **Advisory**：heuristic、未来兼容性、产品/runtime 建议，默认不要求增加 Skill 文本。

同一根因只设一个主维度。分数只能在 finding 和 unknown ledger 完成后填写；低于 5 的分数必须关联至少一个 finding 或 unknown。同一 finding 只能直接关联一个主维度。

## Finding Admission Gate

任何 P0/P1 在进入报告或失败 gate 前必须包含：

1. **Location**：问题的精确位置。
2. **Affected scenario**：目标场景及会产生的具体失败。
3. **Evidence**：直接支持结论的 observed、normative 或 structural 证据。
4. **Owner**：问题属于 Skill、schema、client、runtime、script、role、eval、project 还是 user。
5. **Counterevidence**：已检查的规则、schema、上下文、兼容声明或例外，以及它们为何不能推翻该 finding。
6. **Minimal fix**：最小修改；优先删除、替换或迁移，不默认追加规则。
7. **Verification**：证明修复关闭问题的方法。

无法明确 affected scenario、没有直接证据，或 counterevidence 尚未检查时，不得发布为 P0/P1；降为 P2、Advisory 或 unknown。失败 gate 必须通过 `finding_ids` 关联至少一个严重性相同且已通过本 gate 的 finding；gate 的 `reason` 不能替代 finding 证据。

## 发布结论

按顺序：

1. 任一 P0 gate/finding → `fail`。
2. 任一 P1 gate/finding → `pass-after-fixes`。
3. quick 模式 → `provisional`。
4. delta 模式没有 previous version → `provisional`。
5. 任一必需 gate 为 `unknown` → `provisional`。
6. 复杂度结论为 `over-specified` 或 `over-engineered`，且没有更高优先级 P0/P1 结论 → `provisional`。
7. full/release coverage 低于 100%，或总体 confidence 低于 medium → `provisional`。
8. release 模式未核对 current-check 来源 → `provisional`。
9. 其余情况 → `pass`。

方向独立报告：`aligned`、`at-risk`、`drifted`。`over-specified` 至少为 `at-risk`；`over-engineered` 为 `drifted`。需要根本重构时使用 `drifted` 和改进路线表达，不用未经校准的分数自动产生 `redesign` 发布结论。
