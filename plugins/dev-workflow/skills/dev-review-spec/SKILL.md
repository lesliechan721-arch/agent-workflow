---
name: dev-review-spec
description: 当已有 Spec、计划或设计草案，需要正式判断是否可以批准、是否仍缺材料决定、是否可实现可验证，或是否规定过度时使用。该 Skill 可以单独调用；正式结论必须来自 fresh 独立 reviewer 上下文。
---

# Dev Review Spec

你是 Review 协调器。正式 Spec Review 由一个 fresh 独立 reviewer 完成。

## 审查

1. 固定本次审查的 Spec 和版本标识。报告必须能说明审查的是哪一版内容。
2. 只向 reviewer 提供目标 Spec、它明确引用的决定与 Prototype 证据、必要仓库事实和适用规范。
3. 创建一个 fresh reviewer，只读检查决策完整性、可实现性、可验证性和边界纪律。
4. 初次 Review 一次报告当前证据支持的全部 blocker。每个 blocker 必须说明材料影响和可验证关闭条件；仅有 reviewer 偏好、更优方案或更简洁写法时，放入非阻塞建议。
5. reviewer 无法创建、未完成，或审查目标在过程中变化时，返回 `incomplete`，不覆盖已有正式报告。
6. reviewer 完成后再次确认目标没有变化，再保存结论。协调器可以统一格式，但不得改变 finding 的实质判断。

如果已有上一份正式 Spec Review，或用户明确要求复审，先读取 [Spec 复审](references/rereview.md)。初次 Review 不读取该文件。

## 报告

默认在回复中报告。需要持久化且未指定路径时，覆盖：

```text
docs/dev/<task-slug>/spec-review.md
```

报告记录 Target、Version、Assurance、Result、主要 findings、剩余风险和建议动作。Assured 模式或用户明确要求保留历史时，额外保存到：

```text
docs/dev/<task-slug>/reviews/spec/<timestamp>.md
```

使用 [规格审查模板](assets/spec-review-template.md)。

## Finding 路由

- `material-decision`：补充材料决定。
- `evidence-needed`：收集体验、实验或运行证据。
- `spec-defect` 或 `over-specified`：修订 Spec。
- `fact-gap` 或 `mechanical-validation`：补充事实、测试或工具证据。

只有最新 Review 为 `clean`，当前 Spec 才可以进入批准。`blocked` 时返回 findings 和一个能力级建议；`incomplete` 时先补足审查条件，再重新执行本 Skill。

## 输出

```text
结果：clean / blocked / incomplete
产物：<报告路径 / 无>
未解决：<阻塞问题或无>
建议动作：<补充决定 / 收集证据 / 修订 Spec / 批准当前 Spec / 重试审查 / 请求用户决定>
```

先报告，不修改被审 Spec。
