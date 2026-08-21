# Code Review

## 结论

`clean` 或 `blocked`，并说明审查范围和证据限制。

## Spec fidelity

按影响排序列出：遗漏、scope creep、未批准材料偏离、验收缺口和 Prototype 结论丢失。

每项包含位置、预期、实际、影响和处理类型。没有问题时写“无”。

## Engineering quality

按影响排序列出正确性、安全性、故障处理、并发、维护性、项目规范、测试可信度和不必要复杂度问题。

每项包含位置、证据、影响、建议方向和处理类型。没有问题时写“无”。

处理类型使用：`implementation-defect` / `spec-fidelity` / `spec-defect` / `material-decision` / `evidence-needed`。

## 已运行验证

列出实际命令或行为检查及结果。没有运行时说明原因。

## 建议动作

描述一个最小动作，不指定由哪个 Skill 执行。
