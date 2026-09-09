---
name: dev-review-code
description: 当需要独立审查代码改动、milestone、diff、branch 或 PR 的需求符合度与工程质量，或复审修复后的结果时使用。审查范围可以是阶段或最终交付；仅报告，不修复代码。Fast/Standard 默认一个 fresh reviewer，Assured 或明确要求时两个 reviewer 分轴。
---

# Dev Review Code

协调 fresh 独立双轴审查。Skill 可以单独使用；审查本身不授权修复、提交或后续执行。

## 确定目标

1. 明确本次是阶段判断还是最终交付判断，并固定范围和版本。有 Spec 时记录它的版本；没有时使用用户请求及已确认验收。
2. 阶段 Review 读取 [Milestone 审查](references/milestone-review.md)。最终 Review 覆盖原始任务范围内的完整集成结果，不只看最近 checkpoint。
3. 只向 reviewer 提供固定目标、必要规范和验证证据。Fast/Standard 或未指定时一个 fresh reviewer 覆盖双轴；Assured 或用户明确要求独立双轴时两个 reviewer 分轴。补充专项审查时明确证据缺口和覆盖范围，不把局部通过当作整体 clean。

## 判断

4. **Spec fidelity**：检查当前范围内的遗漏、scope creep、未批准材料偏离、验收和已确认 Prototype 结论。
5. **Engineering quality**：检查正确性、安全、故障与并发、可维护性、项目约定、测试可信度、不必要复杂度和无消费者价值的过程历史泄漏。
6. 一次报告当前证据支持的全部 blocker。每项有位置/证据、材料影响和可验证关闭条件；偏好、更优架构或更简洁写法属于建议，不能单独阻断。
7. 测试 finding 说明实际风险和最低稳定验证边界。文案、私有布局、内部 prompt、全文 snapshot/hash 只有自身是公开合同时才可能成为 blocker。
8. 必需 reviewer 无法创建、未完成或目标变化时报告 `incomplete`，不覆盖已有有效报告。审查结束核对当前目标，再呈现两轴结果；有分歧时说明证据，不能删除未合理关闭的有效 blocker 来形成 clean。

已有上一份正式报告或明确复审时，读取 [复审](references/rereview.md)；首次 Review 不加载该文件。

## 报告

使用 [审查报告模板](assets/code-review-template.md)，省略无关段落。默认对话报告；需要持久记录时遵循调用者路径或仓库约定。未指定时，最终报告可写 `docs/dev/<task-slug>/code-review.md`；阶段报告单独保存，不覆盖最终结论。Assured 或用户明确要求保留历史时额外保存版本，遵循指定路径或项目政策；无约定时使用 `docs/dev/<task-slug>/reviews/code/<timestamp>.md`。

明确 `clean / blocked / incomplete`、范围、版本和结论的用途。阶段 clean 只表示所审边界可继续；只有最新完整交付范围的 clean 才支持最终交付。

实现缺陷交由实现者修复；Spec 缺陷、材料决定或证据缺口分别指出所需上游动作。先报告，不修改代码、测试、Spec 或共享工作状态。
