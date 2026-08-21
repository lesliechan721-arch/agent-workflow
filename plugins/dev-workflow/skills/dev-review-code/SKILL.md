---
name: dev-review-code
description: 当已有代码改动、diff、branch 或 PR，需要独立检查需求或 Spec 符合度和工程质量时使用。该 Skill 可以单独调用；正式结论必须来自两个 fresh 独立 reviewer 上下文。
---

# Dev Review Code

你是 Review 协调器，不是 reviewer。正式 Code Review 必须使用两个 fresh 独立子代理，并行检查两个审查轴。

## 固定审查目标

1. 明确 Base 与 Head。优先使用用户指定范围；否则使用当前分支与目标分支的 merge-base。
2. 有未提交变化时，对本次精确 diff 计算可复算 revision；只有提交变化时使用 commit range。
3. 有 Spec 时记录 Spec 路径与 revision；没有 Spec 时使用用户原始请求和明确验收作为 fidelity 基准。

## 独立双轴审查

4. 只向 reviewer 提供固定目标、必要规范和验证证据。不要传入实现者自我评价、期望 verdict 或隐藏推理。
5. 并行创建两个 fresh reviewer：
   - **Spec fidelity reviewer**：检查遗漏、scope creep、未批准材料偏离、验收缺口和 Prototype 结论丢失。
   - **Engineering quality reviewer**：检查正确性、安全性、故障处理、并发、维护性、项目规范、测试可信度和不必要复杂度。
6. 任一 reviewer 无法创建、不是 fresh context、未完成，或目标在审查中变化时，返回 `incomplete`。不要用当前上下文补做缺失轴，也不要覆盖已有正式报告。
7. 两个 reviewer 完成后重新确认目标 revision 未变化。按两个轴并列呈现结果；协调器可以统一格式和交叉引用同一根因，但不得移动、删除或弱化 finding。

## 报告与历史

默认在回复中报告。需要持久化且未指定路径时，覆盖：

```text
docs/dev/<task-slug>/code-review.md
```

Git 负责普通历史。Assured 模式或用户明确要求保留轮次时，额外把本次完整报告写入：

```text
docs/dev/<task-slug>/reviews/code/<timestamp>.md
```

不创建额外 pointer、round lineage 或 finding registry。

读取并使用 [代码审查模板](assets/code-review-template.md)。报告必须绑定 Base、Head 或 Diff revision，以及适用的 Spec revision。目标变化后必须重新审查。

## 输出

```text
结果：clean / blocked / incomplete
产物：<报告路径 / 无>
未解决：<阻塞问题或无>
建议动作：<修复实现 / 修订 Spec / 补充决定或证据 / 可以交付>
```

先报告，不修改代码、测试或 Spec。
