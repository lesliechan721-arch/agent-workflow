# 评分模型

评分用于诊断完整评审的薄弱维度。它不创建 finding，不决定 design，也不提供发布事实。

## 适用模式

- `full`：固定评估 12 个维度。
- `quick`、`delta`：不评维度，不计算 coverage、总分或总体 confidence。

## 0–5 分锚点

- **5 — 优秀**：设计正确、材料完整、无实质缺陷；关键判断有行为或权威证据，或正确证明组件无需存在。
- **4 — 良好**：主体可靠，只有局部清晰度、覆盖或验证缺口。
- **3 — 合格**：能工作，但存在明显改进空间、证据不足或反复降低质量的问题。
- **2 — 较弱**：目标场景中容易失败，需要实质修改。
- **1 — 很差**：该维度大部分缺失、错误或与目标不一致。
- **0 — 无效**：直接矛盾、关键机制不可执行，或完全破坏 Skill 目标。

允许 0.5 步进。组件应当不存在且被正确省略时可得 4–5；缺少必要材料时使用 `score=null`，不得猜分。

## 置信度

- `high`：行为结果，或权威来源与被审内容共同直接支持。
- `medium`：静态材料完整，但缺少运行验证。
- `low`：主要是 heuristic/inference，或材料不完整。
- `unknown`：缺少必要材料；仅与 `score=null` 一起使用。

每个维度必须用一句 `basis` 说明分数依据，或说明无法评估所缺的证据。Finding-first：先完成 finding 和 unknown，再评分；分数不得反向产生 finding。

## 计算

权重只从 `assets/review-dimensions.json` 读取，不复制进 QualityReviewResult。

- `coverage = assessed_weight / 100`。
- coverage 为 100% 时，`weighted_score = Σ(weight × score / 5)`；否则为 `null`。
- confidence factor：high=1.0、medium=0.7、low=0.4、unknown=0。
- confidence index 按已评估权重加权。
- high：coverage=100% 且 confidence index ≥ 0.8。
- medium：coverage≥80% 且 confidence index ≥ 0.6。
- low：其余有已评估维度的情况。
- unknown：没有已评估维度。

总分保留一位小数，confidence index 保留两位。full 主报告只显示总分、coverage 和总体 confidence；维度明细保留在结构化 JSON。

## Design 边界

依次应用：

1. 机器检查失败或存在 admitted critical finding → `fail`。
2. `over-engineered` → `redesign` 或 `fail`。
3. full coverage 低于 100%，或总体 confidence 为 low/unknown → `not-assessed`。
4. major finding → 至少 `needs-fixes`；`over-specified` 不能为 `pass`。
5. 分数高低本身不改变 design。

不生成 quality band、raw/effective 双分、reducibility、release readiness 或 gate 表。
