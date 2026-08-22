---
name: dev-review-spec
description: 当已有 Spec、计划或设计草案，需要正式判断是否可以批准、是否仍缺材料决定、是否可实现可验证，或是否规定过度时使用。该 Skill 可以单独调用；正式结论必须来自 fresh 独立 reviewer 上下文。
---

# Dev Review Spec

你是 Review 协调器。正式 Spec Review 由一个 fresh 独立 reviewer 完成。直接调用且没有保障等级时按 Standard 处理自动修复预算。

## 审查

1. 固定本次审查的 Spec 和版本标识。报告必须能说明审查的是哪一版内容。
2. 只向 reviewer 提供目标 Spec、它明确引用的决定与 Prototype 证据、必要仓库事实和适用规范；复审时再提供上一份正式 Review 报告。
3. 创建一个 fresh reviewer，只读检查决策完整性、可实现性、可验证性和边界纪律。
4. 初次 Review 一次报告当前证据支持的全部 blocker；偏好性改进和没有材料影响的更优写法放入非阻塞建议。
5. reviewer 无法创建、未完成，或审查目标在过程中变化时，返回 `incomplete`，不覆盖已有正式报告。
6. reviewer 完成后再次确认目标没有变化，再保存结论。协调器可以统一格式，但不得改变 finding 的实质判断。

## 报告

默认在回复中报告。需要持久化且未指定路径时，覆盖：

```text
docs/dev/<task-slug>/spec-review.md
```

报告记录 Target、Version、Assurance、Result、Repair round、Progress、Automatic repair 和主要 findings。Assured 模式或用户明确要求保留历史时，额外保存到：

```text
docs/dev/<task-slug>/reviews/spec/<timestamp>.md
```

使用 [规格审查模板](assets/spec-review-template.md)。

## 修复与复审

- `material-decision`：补充材料决定。
- `evidence-needed`：收集体验、实验或运行证据。
- `spec-defect` 或 `over-specified`：修订 Spec。
- `fact-gap` 或 `mechanical-validation`：补充事实、测试或工具证据。
- 修复范围只包含当前 blocker、解决它们必需的影响面和修订直接引入的 regression。
- 修订或补证完成后，创建新的 fresh reviewer，重新执行当前完整 Spec 的四个审查维度，而不是只确认旧 finding。
- 复审与上一份报告比较：blocker 实质减少或影响下降为 `advancing`；同一 blocker 无新证据重复、没有实质减少，或新增 blocker 不能归因为 `repair-regression`、`previously-hidden` 或 `critical-omission` 时为 `stalled`；修订引入更严重问题时为 `regressed`。
- Fast 不自动修复；Standard 最多两轮；Assured 最多三轮。达到预算、`stalled` 或 `regressed` 时把 Automatic repair 设为 `stop`，请求用户决定，不再建议自动修订。

只有最新 Review 为 `clean`，当前 Spec 才可以进入批准。`incomplete` 时先补足审查条件，再重新执行本 Skill。

## 输出

```text
结果：clean / blocked / incomplete
产物：<报告路径 / 无>
进展：initial / advancing / stalled / regressed
自动修复：not-needed / continue / stop
未解决：<阻塞问题或无>
建议动作：<补充决定 / 收集证据 / 修订 Spec / 批准当前 Spec / 重试审查 / 请求用户决定>
```

先报告，不修改被审 Spec。自动修复停止时只说明停止原因和用户可选动作。
