# Code Review

- Review target: `<commit range or current diff>`
- Implementation version: `<version identifier>`
- Spec: `<path / none>`
- Spec version: `<version identifier / none>`
- Assurance: `Fast | Standard | Assured`
- Result: `clean | blocked | incomplete`
- Reviewer topology: `one dual-axis reviewer | two axis reviewers`

## 结论

用一句话说明是否可以交付。`incomplete` 说明缺失的审查轴、目标稳定性或证据。

## Spec fidelity

一次列出当前证据支持的全部遗漏、scope creep、未经批准的材料偏离和验收缺口，并按影响排序。

每项包含位置、预期、实际、影响、类型和可验证关闭条件。没有问题时写“无”。

## Engineering quality

一次列出当前证据支持的正确性、安全性、故障处理、并发、维护性、项目规范、测试可信度和不必要复杂度问题，并按影响排序。

每项包含位置、证据、影响、建议方向、类型和可验证关闭条件。测试 finding 还应说明被保护的可观察风险和最低稳定验证 seam。没有问题时写“无”。

最终产物泄漏被否决方案、Review 过程、修复历史或无消费者价值的否定性指令时，只有它会误导消费者、改变公开行为或违反当前合同时才作为 blocker；其它情况放入非阻塞建议。

类型使用：`implementation-defect` / `spec-fidelity` / `spec-defect` / `material-decision` / `evidence-needed`。

## 非阻塞建议

记录偏好性简化、相邻重构和不改变当前交付门槛的改进。没有时写“无”。

## 已运行验证

列出实际命令或行为检查及结果。没有运行时说明原因。

## 与上一份 Review 比较

仅在复审时保留：

- 已解决：
- 仍存在：
- 新发现：

## 建议动作

说明下一步需要完成哪类工作，以及满足什么条件后可以重新审查。Review 需要用户决定时，只给用户可选动作，不继续自动修复。
