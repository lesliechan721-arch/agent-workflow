# Code Review

- Base: `<commit or merge-base>`
- Head: `<commit or working tree>`
- Diff revision: `<commit range or sha256 of exact diff>`
- Spec: `<path / none>`
- Spec revision: `<git blob/OID, sha256, or none>`
- Reviewed at: `<ISO-8601>`
- Review contexts: `independent-spec-fidelity, independent-engineering-quality`
- Result: `clean | blocked | incomplete`

## 结论

用一句话说明是否可以交付。`incomplete` 必须说明缺失的独立审查轴、目标稳定性或证据。

## Spec fidelity

按影响排序列出遗漏、scope creep、未批准材料偏离、验收缺口和 Prototype 结论丢失。

每项包含位置、预期、实际、影响和处理类型。没有问题时写“无”。

## Engineering quality

按影响排序列出正确性、安全性、故障处理、并发、维护性、项目规范、测试可信度和不必要复杂度问题。

每项包含位置、证据、影响、建议方向和处理类型。没有问题时写“无”。

处理类型使用：`implementation-defect` / `spec-fidelity` / `spec-defect` / `material-decision` / `evidence-needed`。

## 已运行验证

列出实际命令或行为检查及结果。没有运行时说明原因。

## 建议动作

描述一个最小动作，不指定由哪个 Skill 执行。
