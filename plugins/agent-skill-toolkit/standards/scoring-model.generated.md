# Scoring Model

> GENERATED maintainer reference. Runtime reviewers use the mode-specific rubric/dimensions and the validator; do not load this file into a normal review context.

full/release-quality 使用 12 维评分。quick/delta 不计算总分。总分和 quality band 只进入技术附录与 JSON，不决定发布结论。

## Canonical dimensions

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
| `evals` | Eval 设计、Oracle 有效性与修改安全 | 9 |
| `reliability` | 可靠性、安全与兼容性 | 4 |
| `maintainability` | 剪枝、事实源与变更纪律 | 4 |

## Deterministic ownership

- `scripts/validate-review-result.mjs` validates canonical weights and computes coverage, weighted score, confidence, design and release readiness.
- `quick` / `delta` do not produce a weighted score. `full` / `release-quality` must cover every canonical dimension exactly once.
- Findings and unknowns are established before scores. A score below 5 must link a finding or unknown.
- Quality bands are diagnostic only; they do not override release gates.

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
| `structural` | 符合 `SKILL.md` exact-claim 与完整前提定义的直接断裂、无效配置、矛盾或不可执行关系 | 是 |
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

只有 full/release-quality 且 12 个维度全部完成时计算 `weighted_score` 和 raw/effective quality band。quick/delta 的这些字段为 `null`。

同时报告：

- coverage：已评估权重占 100 的比例。
- confidence index：high=1.0、medium=0.7、low=0.4、unknown=0，按已评估权重加权。
- raw quality band：90–100 excellent；80–89.5 strong；70–79.5 adequate；60–69.5 weak；<60 poor。
- effective quality band：先使用 raw quality band，再应用复杂度上限；`over-specified` 不高于 `adequate`，`over-engineered` 不高于 `weak`。

总分和 raw/effective quality band 只用于定位薄弱维度、比较同一 Skill 的版本和观察趋势。它们不定义设计结论或发布就绪度，也不用于直接比较用途或结构不同的 Skill。

## 复杂度结论

full/release-quality 必须在评分前完成最小有效控制审计，并给出独立结论：

- `minimal`：强制规则均有明确依据，无法在保留核心行为时实质缩短。
- `proportionate`：控制强度与任务脆弱度匹配，只有局部可选简化。
- `over-specified`：主体正确，但多个 always-loaded 强制规则、阶段或 artifact 缺少足够依据，合理策略空间受到限制。
- `over-engineered`：Skill 接近完整 runbook 或人工 SOP，控制结构替代了模型应承担的领域判断。

JSON 同时保存 reducibility：`almost-none`、`minor`、`significant`、`core-plus-reference` 或 `redesign`。`minimal` 和 `proportionate` 要求 `minimum_control` 高于 3；`over-specified` 必须关联该维度 finding，内部方向不能为 `aligned`；`over-engineered` 必须关联该维度 finding，内部方向为 `drifted`。方向和 reducibility 是技术诊断，不进入主报告顶层。缺少 ablation 时可以使用 `needs-ablation`；当多个强制规则的必要性仍未知时，不能把最小控制维度评为 4–5。

## 证据上限提示

脚本不自动改分，但下列高分必须解释：

- 没有 trigger eval 结果，`triggering` 通常不高于 3。
- 没有 pointer audit，`triggering` 通常不高于 4。
- 没有 completion-boundary audit，`instruction_design` 通常不高于 4。
- full/release-quality 没有 minimum-effective-control audit 时 scorecard 无效；quick/delta 没有该审计时，`minimum_control` 通常不高于 3。
- 没有 information-hierarchy map，`context_disclosure` 通常不高于 4。
- 有脚本但未做安全静态检查、`--help` 或样例运行，`scripts` 通常不高于 3。
- 只有 eval 文件，没有 Case Admission Audit，`evals` 通常不高于 2。
- Case 设计、oracle 和现实性已审计，但没有实际运行，`evals` 通常不高于 3。
- 有运行但没有适用 baseline、方差解释、错误代价政策或 failure triage，`evals` 通常不高于 4。
- 已知错误 oracle 仍驱动当前修改，`evals` 通常不高于 1。
- 有具体兼容性声明但未验证，`reliability` 通常不高于 3。
- delta 模式没有上一版，`maintainability` 通常不高于 3。

## 发布门禁

1. `package-validity`：frontmatter、name/目录和必需结构有效。
2. `critical-artifacts`：核心流程引用的文件存在且可用。
3. `goal-alignment`：Skill 没有与目标、授权或范围直接矛盾。
4. `capability-validity`：核心流程不依赖不存在、未公开或被禁止的能力。
5. `safety-permissions`：不会静默越权、泄露敏感数据或执行不受控副作用。
6. `architecture-ownership`：核心正确性不依赖无法可靠维护的自然语言 runtime 状态机。
7. `release-evidence`：release-quality 模式具备真实运行、适用 baseline、trace、重复运行、质量和成本证据。
8. `eval-validity`：仅在被审 Skill 含 eval，或当前判断使用 eval 结果时适用；关键 case 的层级、前提、oracle、assertion、现实性和版本关系可靠。已知错误、陈旧或 diagnostic-only case 不进入发布指标。
9. `eval-change-safety`：仅在 eval 已驱动或准备驱动当前修改时适用；失败已正确归因，修复经过同族变体、minimal pair、固定 validation/sanity、关键 regression 和复杂度回归。

门禁状态：`pass`、`fail`、`unknown`、`not_applicable`。高分不能覆盖门禁失败。

- `eval-validity=fail`：当前 suite 不得继续驱动 Skill 修改；先修复、重新裁决或移除错误用例。
- `eval-validity=unknown`：eval 只能作为诊断信号，不能单独形成 P0/P1 或发布结论。
- `eval-change-safety=fail`：拒绝当前 eval-driven 修改，即使目标 case 已转为通过。
- 目标没有 eval，且当前判断未使用任何 eval 结果时，`eval-validity=not_applicable`；没有 eval-driven 修改时，`eval-change-safety=not_applicable`。

## Finding 与 gate 关联

所有模式统一使用 `SKILL.md` 的严重性和 Finding Admission Gate；本文件不重复定义。full/release-quality 的结构化 finding 还必须通过 `scripts/validate-review-result.mjs`。

同一根因只设一个主维度。分数只能在 finding 和 unknown ledger 完成后填写；低于 5 的分数必须关联至少一个 finding 或 unknown。同一 finding 只能直接关联一个主维度。失败 gate 必须通过 `finding_ids` 关联至少一个严重性相同且已通过 Admission Gate 的 finding；gate 的 `reason` 不能替代 finding 证据。

## 设计结论与发布就绪度

validator 分开计算 `decision.design` 和 `decision.release_readiness`。不得再使用 `pass-after-fixes`。

设计结论按顺序：

1. 任一 P0 gate/finding → `fail`。
2. composition 为 `overloaded` 或 `orchestrator-needed`，或复杂度为 `over-engineered`，或内部方向为 `drifted` → `redesign`。
3. 任一 P1 gate/finding → `needs-fixes`。
4. 复杂度为 `over-specified` → `needs-fixes`。
5. quick，或缺少可用 previous version 的 delta → `not-assessed`。
6. full/release-quality coverage 低于 100%，或总体 confidence 为 low → `not-assessed`。
7. 其余情况 → `pass`。

发布就绪度按顺序：

1. 任一 P0/P1 gate/finding，或设计结论为 `redesign` → `blocked`。
2. quick/delta → `not-assessed`。
3. 任一必需 gate 为 `unknown` → `provisional`。
4. 复杂度为 `over-specified` → `provisional`。
5. full/release-quality coverage 低于 100%，或总体 confidence 为 low → `provisional`。
6. release-quality 模式未核对 current-check 来源 → `provisional`。
7. 其余情况 → `ready`。

因此，“没有 P0/P1，但缺少 runtime/eval 证据”应输出设计 `pass` 和发布 `provisional`。低总分本身不改变这两个结论。内部方向仍保存为 `aligned`、`at-risk` 或 `drifted`；`over-specified` 至少为 `at-risk`，`over-engineered` 为 `drifted`。
