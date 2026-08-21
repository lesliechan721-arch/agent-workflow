# Code Review

- Review range: `<commit range or current diff>`
- Implementation version: `<version identifier>`
- Spec: `<path / none>`
- Spec version: `<version identifier / none>`
- Reviewed at: `<ISO-8601>`
- Review mode: `independent-spec-fidelity + independent-engineering-quality`
- Result: `clean | blocked | incomplete`

## 结论

用一句话说明是否可以交付。`incomplete` 说明缺失的审查轴、目标稳定性或证据。

## Spec fidelity

按影响排序列出遗漏、scope creep、未经批准的材料偏离和验收缺口。

每项包含位置、预期、实际、影响和类型。没有问题时写“无”。

## Engineering quality

按影响排序列出正确性、安全性、故障处理、并发、维护性、项目规范、测试可信度和不必要复杂度问题。

每项包含位置、证据、影响、建议方向和类型。没有问题时写“无”。

类型使用：`implementation-defect` / `spec-fidelity` / `spec-defect` / `material-decision` / `evidence-needed`。

## 已运行验证

列出实际命令或行为检查及结果。没有运行时说明原因。

## 修复与复审

- 需要的修复：
- 修复后重新 Review：`yes | no`

## 下一步

给出一个明确动作。
