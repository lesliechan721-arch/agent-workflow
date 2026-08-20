---
name: dev-review-spec
description: 当已有 Spec、计划或设计草案，需要判断是否可以批准、是否仍缺材料决定、是否可实现可验证，或是否规定过度时使用。只读审查并报告 clean/blocked；代码 diff 和实现质量不属于本 Skill。
---

# Dev Review Spec

审查 Spec 是否保存了足够的材料共识，同时给实现者留下合理工程自由。

## 产物位置

默认在回复中报告。需要持久化且未指定路径时，使用与目标 Spec 相同的任务目录：

```text
docs/dev/<task-slug>/spec-review.md
```

## 工作流

1. 确定审查对象和它引用的决定、Prototype 结论及仓库事实。
2. 检查四个维度：
   - **决策完整性**：用户能否知情批准，是否还有隐藏材料决定。
   - **可实现性**：新的合格实现者能否开始，而不用重新询问材料问题。
   - **可验证性**：验收示例和观察 seam 能否区分正确与错误结果。
   - **边界纪律**：是否把任务步骤、机器状态协议、局部实现或假设性规则写进 Spec。
3. 为每个 finding 标注一个中性处理类型：
   - `material-decision`：需要用户承担取舍；
   - `evidence-needed`：必须通过体验、实验、测量或运行结果决定；
   - `spec-defect`：Spec 冲突、遗漏或表述错误；
   - `over-specified`：应删除或移入实现工作记忆；
   - `fact-gap`：可调查事实缺失；
   - `mechanical-validation`：需要脚本、测试或项目工具验证。
4. 读取并使用 [规格审查模板](assets/spec-review-template.md)，输出 `clean` 或 `blocked`。先报告，不直接修改目标。

`clean` 表示用户可以知情批准，一个新的合格实现者无需补做材料决定。它不表示实现者无需完成局部工程设计。
