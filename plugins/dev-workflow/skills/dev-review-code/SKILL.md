---
name: dev-review-code
description: 当已有代码改动、diff、branch 或 PR，需要同时检查需求或 Spec 符合度和工程质量时使用。分开报告行为偏离与正确性、安全性、可维护性和测试问题；规格本身是否可批准使用 dev-review-spec。
---

# Dev Review Code

使用双轴审查，避免“代码写得好”掩盖“实现错需求”，也避免“满足需求”掩盖工程缺陷。

## 工作流

1. 确定审查目标、基线和预期行为。读取当前请求、Spec、相关决定、Prototype 结论、diff 和验证证据。
2. 审查 **Spec fidelity**：遗漏、范围膨胀、未经确认的材料偏离、验收未满足、Prototype 结论丢失。
3. 审查 **Engineering quality**：正确性、安全性、故障处理、并发、可维护性、项目约定、测试可信度和不必要复杂度。
4. 在安全且成本合理时运行有针对性的测试、静态检查或复现。无法运行时明确证据限制。
5. 读取并使用 [代码审查模板](assets/code-review-template.md)，分开呈现两个轴，按影响排序 finding，输出 `clean` 或 `blocked`。先报告，不直接修改代码。

代码问题交给 `dev-implement`。局部需求遗漏使用 `requirements-clarifier`；新的材料产品或架构决定使用 `decision-grill` 并更新 Spec。
