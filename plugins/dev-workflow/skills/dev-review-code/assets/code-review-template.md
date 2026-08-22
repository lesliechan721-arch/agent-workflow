# Code Review

- Review target: `<commit range or current diff>`
- Implementation version: `<version identifier>`
- Spec: `<path / none>`
- Spec version: `<version identifier / none>`
- Assurance: `Fast | Standard | Assured`
- Result: `clean | blocked | incomplete`
- Reviewer topology: `one dual-axis reviewer | two axis reviewers`
- Repair round: `<0 for initial review; increment after each repair>`
- Progress: `initial | advancing | stalled | regressed`
- Automatic repair: `not-needed | continue | stop`

## 结论

用一句话说明是否可以交付。`incomplete` 说明缺失的审查轴、目标稳定性或证据。

## Spec fidelity

一次列出当前证据支持的全部遗漏、scope creep、未经批准的材料偏离和验收缺口，并按影响排序。

每项包含位置、预期、实际、影响和类型。复审中新增的 blocker 还包含来源。没有问题时写“无”。

## Engineering quality

一次列出当前证据支持的正确性、安全性、故障处理、并发、维护性、项目规范、测试可信度和不必要复杂度问题，并按影响排序。

每项包含位置、证据、影响、建议方向和类型。复审中新增的 blocker 还包含来源；测试 finding 还应说明被保护的可观察风险和最低稳定验证 seam。没有问题时写“无”。

类型使用：`implementation-defect` / `spec-fidelity` / `spec-defect` / `material-decision` / `evidence-needed`。
复审新增 blocker 的来源使用：`repair-regression` / `previously-hidden` / `critical-omission`。

## 非阻塞建议

记录偏好性简化、相邻重构和不改变当前交付门槛的改进。没有时写“无”。

## 已运行验证

列出实际命令或行为检查及结果。没有运行时说明原因。

## 修复与复审

- 允许的修复范围：当前 blocker、必需影响面、直接 regression
- 复审条件：
- 与上一轮相比：
- 停止原因：`无 / stalled / regressed / budget-exhausted / reviewer-conflict`

## 建议动作

给出一个明确的能力级动作，不指定具体 Skill。Automatic repair 为 `stop` 时只给用户决策选项，不继续自动修复。
