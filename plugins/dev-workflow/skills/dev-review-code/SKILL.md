---
name: dev-review-code
description: 当已有代码改动、diff、branch 或 PR，需要正式检查需求或 Spec 符合度和工程质量，或需要复审修复后的实现时使用。该 Skill 可以单独调用；正式结论必须来自两个 fresh 独立 reviewer 上下文。
---

# Dev Review Code

你是 Review 协调器。正式 Code Review 由两个 fresh 独立 reviewer 并行完成。

## 审查目标

1. 明确本次审查范围：用户指定范围、commit range 或当前工作区 diff。
2. 有 Spec 时记录 Spec 路径和版本；没有 Spec 时使用用户请求和明确验收作为 fidelity 基准。
3. 报告必须能说明审查的是哪一版实现和哪一版 Spec。

## 独立双轴审查

4. 只向 reviewer 提供固定目标、必要规范和验证证据。
5. 并行创建两个 fresh reviewer：
   - **Spec fidelity**：检查遗漏、scope creep、未经批准的材料偏离、验收缺口和 Prototype 结论丢失。
   - **Engineering quality**：检查正确性、安全性、故障处理、并发、可维护性、项目约定、测试可信度和不必要复杂度。
6. 任一 reviewer 无法创建、未完成，或审查目标在过程中变化时，返回 `incomplete`，不覆盖已有正式报告。
7. 两个 reviewer 完成后再次确认目标没有变化。按两个轴并列呈现结果，不弱化或移动 finding。

## 报告

默认在回复中报告。需要持久化且未指定路径时，覆盖：

```text
docs/dev/<task-slug>/code-review.md
```

报告记录 Review range、Implementation version、Spec version、Result 和两个审查轴。Assured 模式或用户明确要求保留历史时，额外保存到：

```text
docs/dev/<task-slug>/reviews/code/<timestamp>.md
```

使用 [代码审查模板](assets/code-review-template.md)。

## 修复与复审

- `implementation-defect` 或 `spec-fidelity`：使用 `dev-implement` 修复实现并运行验证。
- `spec-defect`：使用 `dev-spec` 修订，重新完成 Spec Review 和批准后再修复实现。
- `material-decision`：使用 `decision-grill`。
- `evidence-needed`：使用 `decision-prototype`。
- 任何代码或 Spec 变化后，重新运行 `dev-review-code`；正式复审再次执行两个完整审查轴。

循环在最新 Review 为 `clean`、`incomplete`、用户停止、出现未决材料决定或缺少高风险授权时结束。

## 输出

```text
结果：clean / blocked / incomplete
产物：<报告路径 / 无>
未解决：<阻塞问题或无>
下一步：<dev-implement / dev-spec / decision-grill / decision-prototype / 可以交付 / 重试 Review>
```

先报告，不修改代码、测试或 Spec。
