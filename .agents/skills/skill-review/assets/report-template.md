# `<Skill name>` 评审

本模板只用于 full/release 的人读主报告。主报告是决策摘要，不是 reviewer 工作底稿。完整门禁、12 维评分、finding admission 和专项审计使用 `review-appendix-template.md`；结构化 ledger 使用 `scorecard-template.json`。

删除空章节和 `not_applicable` 章节。同一事实只在一个权威位置展开，其它位置只引用 ID。

## 结论

- **设计结论：** pass | needs-fixes | redesign | fail | not-assessed
- **发布就绪度：** ready | provisional | blocked | not-assessed
- **复杂度：** minimal | proportionate | over-specified | over-engineered | not-assessed
- **证据：** coverage `<百分比>`；confidence `high | medium | low`

**判断：**

用 2–4 句话说明 Skill 是否解决目标问题、最重要的风险、是否需要修改生产正文，以及发布前还缺什么。不要在这里重复 finding、gate 或 unknown 的完整叙述。

**下一步：**

只引用行动路线中当前最重要的一个 Action ID，不重复动作正文。

## 必须处理

没有 P0/P1 时写：

> 没有已证实的发布阻断或必须修改项。

存在 P0/P1 时，每项使用以下短块。完整 admission 记录只放技术附录和 JSON。

### `<F-ID>` `<标题>` — P0 | P1

**为什么重要：**

说明它会在哪个可达场景中造成什么实际影响。

**证据：**

列出最直接的 1–3 个来源定位，并引用附录中的 admission ID。

**建议：**

说明最小修改。优先删除、替换、修 eval、修 runner 或补证据；不要默认扩写 `SKILL.md`。

**完成标准：**

说明怎样证明问题已经关闭。

## 高价值改进

默认最多 3 项。用户明确要求详细报告时最多 5 项。只保留会明显改善质量、简化 Skill 或降低发布风险的 P2。其余 P2 和 Advisory 只保留在 scorecard。

1. **`<P2-ID>` `<标题>`：** 当前问题、最小动作和预期收益。

## 已经可靠的部分

最多 3 项。每项必须有包内材料、normative 或 observed 证据支持。

- ...

## 决策关键的证据缺口

只列会改变设计结论或发布就绪度的 unknown。普通未知信息只保留在 scorecard。

| ID | 缺少的证据 | 当前影响 | 获得方式 |
| --- | --- | --- | --- |
| | | | |

## 发布限制

表格只显示 `fail` 或 `unknown` gate。release 模式还要列出安全执行过的脚本和 eval 结果；所有适用 gate 都通过时，用“所有适用发布门禁均已通过”代替表格。full 模式没有发布限制时删除本节。

| Gate | 状态 | 对发布的影响 | Action ID |
| --- | --- | --- | --- |
| | fail / unknown | | |

## 质量概览

只展示需要读者关注的聚合领域，最多 4 行。状态使用 `strong | adequate | weak | unknown`。完整 12 维评分见技术附录。

| 领域 | 状态 | 说明 |
| --- | --- | --- |
| 触发与范围 | | |
| 指令、控制与架构 | | |
| 资源、脚本与披露 | | |
| Eval 与发布证据 | | |

## 行动路线

不要重复 finding 或 unknown 的正文。每个动作只写一次，并引用对应 finding、unknown 或 gate ID。

### 现在

1. **`A-01`：** 当前阻断发布或必须先完成的事项；引用对应 ID。

### 下一步

1. **`A-02`：** 高收益但不阻断当前阶段的改进；引用对应 ID。

### 暂不处理

1. **`A-03`：** 理论风险、低价值边界或需要更多证据的事项；引用对应 ID。

## 停止与重新打开条件

**现在停止，因为：**

说明为什么继续 review 或继续扩写 Skill 没有净收益。

**仅在出现以下情况时重新打开：**

- 新的 observed failure；
- 新的 normative requirement；
- 可复现的 structural contradiction；
- 固定 eval 集出现稳定回归。
