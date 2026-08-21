---
name: dev-review-spec
description: 当已有 Spec、计划或设计草案，需要正式判断是否可以批准、是否仍缺材料决定、是否可实现可验证，或是否规定过度时使用。该 Skill 可以单独调用；正式结论必须来自 fresh 独立 reviewer 上下文。
---

# Dev Review Spec

你是 Review 协调器。正式 Spec Review 由一个 fresh 独立 reviewer 完成。

## 审查

1. 固定本次审查的 Spec 和版本标识。报告必须能说明审查的是哪一版内容。
2. 只向 reviewer 提供目标 Spec、它明确引用的决定与 Prototype 证据、必要仓库事实和适用规范。
3. 创建一个 fresh reviewer，只读检查：
   - 决策完整性；
   - 可实现性；
   - 可验证性；
   - 边界纪律。
4. reviewer 无法创建、未完成，或审查目标在过程中变化时，返回 `incomplete`，不覆盖已有正式报告。
5. reviewer 完成后再次确认目标没有变化，再保存结论。协调器可以统一格式，但不得改变 finding 的实质判断。

## 报告

默认在回复中报告。需要持久化且未指定路径时，覆盖：

```text
docs/dev/<task-slug>/spec-review.md
```

报告记录 Target、Reviewed version、Result 和主要 findings。Assured 模式或用户明确要求保留历史时，额外保存到：

```text
docs/dev/<task-slug>/reviews/spec/<timestamp>.md
```

使用 [规格审查模板](assets/spec-review-template.md)。

## 修复与复审

- `material-decision`：使用 `decision-grill` 补充决定。
- `evidence-needed`：使用 `decision-prototype` 取得证据。
- `spec-defect` 或 `over-specified`：使用 `dev-spec` 修订。
- `fact-gap` 或 `mechanical-validation`：补充事实、测试或工具证据。
- 任何修订完成后，重新运行 `dev-review-spec`，对当前完整 Spec 做一次新的独立审查。

只有最新 Review 为 `clean`，当前 Spec 才可以进入批准。循环在 `clean`、`incomplete`、用户停止或仍有未决材料决定时结束。

## 输出

```text
结果：clean / blocked / incomplete
产物：<报告路径 / 无>
未解决：<阻塞问题或无>
下一步：<decision-grill / decision-prototype / dev-spec / 批准当前 Spec / 重试 Review>
```

先报告，不修改被审 Spec。
