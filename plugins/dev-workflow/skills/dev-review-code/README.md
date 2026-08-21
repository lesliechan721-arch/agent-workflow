# Dev Review Code

对已有实现执行双轴审查：一条轴检查请求或 Spec 符合度，另一条轴检查正确性、安全性、可维护性和测试可信度。

该 Skill 先报告，不直接修复代码。每个 blocker 使用中性处理类型描述，由外层工作流决定后续阶段。需要持久化且没有指定路径时，默认写入 `docs/dev/<task-slug>/code-review.md`。

主要指令见 [`SKILL.md`](SKILL.md)，模板见 [`assets/code-review-template.md`](assets/code-review-template.md)，触发用例见 [`evals/`](evals/)。
