---
name: dev-review-code
description: 当已有代码改动、diff、branch 或 PR，需要正式检查需求或 Spec 符合度和工程质量，或需要复审修复后的实现时使用。该 Skill 可以单独调用；Fast 或 Standard 由一个 fresh reviewer 覆盖双轴，Assured 或用户明确要求时由两个 fresh reviewer 分轴完成。
---

# Dev Review Code

你是 Review 协调器。正式 Code Review 始终覆盖 Spec fidelity 与 Engineering quality。Fast、Standard 或未指定保障时由一个 reviewer 覆盖两个审查轴；Assured 或用户明确要求时由两个 reviewer 分轴完成。

## 审查目标

1. 明确本次审查范围：用户指定范围、commit range 或当前工作区 diff。
2. 有 Spec 时记录 Spec 路径和版本；没有 Spec 时使用用户请求和明确验收作为 fidelity 基准。
3. 报告必须能说明审查的是哪一版实现和哪一版 Spec。

## 独立双轴审查

4. 只向 reviewer 提供固定目标、必要规范和验证证据。
5. 按保障等级创建 reviewer：
   - **Fast、Standard 或未指定**：创建一个 fresh reviewer，同时完成 Spec fidelity 与 Engineering quality。
   - **Assured 或用户明确要求独立双轴**：并行创建两个 fresh reviewer，分别完成一个轴。
6. **Spec fidelity** 检查遗漏、scope creep、未经批准的材料偏离、验收缺口和 Prototype 结论丢失。
7. **Engineering quality** 检查正确性、安全性、故障处理、并发、可维护性、项目约定、测试可信度、不必要复杂度，以及最终产物是否泄漏被否决方案、Review 过程、修复历史或无消费者价值的否定性指令。公开合同、安全或兼容约束，以及高概率复发的非显然 gotcha 可以保留。
8. 初次 Review 一次报告当前证据支持的全部 blocker。每个 blocker 必须说明可观察影响和可验证关闭条件；仅有 reviewer 偏好、更优方案或更简洁写法时，放入非阻塞建议。
9. 测试 finding 必须说明被保护的可观察风险和最低稳定验证 seam。精确文案、排版、私有文件布局、内部 prompt、整文件 snapshot 或 hash 只有在它们本身是公开合同时才可成为 blocker。
10. 任一必需 reviewer 无法创建、未完成，或审查目标在过程中变化时，返回 `incomplete`，不覆盖已有正式报告。
11. reviewer 完成后再次确认目标没有变化。按两个轴呈现结果，不弱化或移动 finding。

如果已有上一份正式 Code Review，或用户明确要求复审，先读取 [Code 复审](references/rereview.md)。初次 Review 不读取该文件。

## 报告

默认在回复中报告。需要持久化且未指定路径时，覆盖：

```text
docs/dev/<task-slug>/code-review.md
```

报告记录 Review target、Implementation version、Spec version、Assurance、Result、Reviewer topology、两个审查轴、验证证据和建议动作。Assured 模式或用户明确要求保留历史时，额外保存到：

```text
docs/dev/<task-slug>/reviews/code/<timestamp>.md
```

使用 [代码审查模板](assets/code-review-template.md)。

## Finding 路由

- `implementation-defect` 或 `spec-fidelity`：修复实现并运行相关验证。
- `spec-defect`：修订 Spec，重新完成规格审查和批准，再更新实现。
- `material-decision`：补充材料决定。
- `evidence-needed`：收集体验、实验或运行证据。

只有最新 Review 为 `clean` 才可以交付。`blocked` 时返回 findings 和一个能力级建议；`incomplete` 时先补足审查条件，再重新执行本 Skill。

## 输出

```text
结果：clean / blocked / incomplete
产物：<报告路径 / 无>
审查拓扑：one dual-axis reviewer / two axis reviewers
未解决：<阻塞问题或无>
建议动作：<修复实现 / 修订 Spec / 补充决定 / 收集证据 / 可以交付 / 重试审查 / 请求用户决定>
```

先报告，不修改代码、测试或 Spec。
