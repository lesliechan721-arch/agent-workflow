---
name: dev-review-code
description: 当已有代码改动、diff、branch 或 PR，需要同时检查需求或 Spec 符合度和工程质量时使用。分开报告行为偏离与正确性、安全性、可维护性和测试问题；规格是否可批准不属于本 Skill。
---

# Dev Review Code

使用双轴审查，避免“代码写得好”掩盖“实现错需求”，也避免“满足需求”掩盖工程缺陷。

## 产物位置

默认在回复中报告。需要持久化且未指定路径时，使用：

```text
docs/dev/<task-slug>/code-review.md
```

## 工作流

1. 确定审查目标、基线和预期行为。读取当前请求、Spec、相关决定、Prototype 结论、diff 和验证证据。
2. 审查 **Spec fidelity**：遗漏、范围膨胀、未经确认的材料偏离、验收未满足、Prototype 结论丢失。
3. 审查 **Engineering quality**：正确性、安全性、故障处理、并发、可维护性、项目约定、测试可信度和不必要复杂度。
4. 在安全且成本合理时运行有针对性的测试、静态检查或复现。无法运行时明确证据限制。
5. 为每个 blocker 标注一个处理类型：
   - `implementation-defect`：代码、测试或工程质量问题；
   - `spec-fidelity`：实现偏离仍然正确的请求或 Spec；
   - `spec-defect`：审查发现规范本身错误或遗漏；
   - `material-decision`：出现新的材料产品或架构取舍；
   - `evidence-needed`：必须取得体验、实验或运行证据才能判断。
6. 读取并使用 [代码审查模板](assets/code-review-template.md)，分开呈现两个轴，按影响排序 finding，输出 `clean` 或 `blocked`。先报告，不直接修改代码。
