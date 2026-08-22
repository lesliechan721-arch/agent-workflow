# Dev Review Code

独立双轴审查已有实现：一条轴检查请求或 Spec 符合度，另一条轴检查正确性、安全性、可维护性和测试可信度。

该 Skill 可以直接调用。正式结论并行使用两个 fresh reviewer；任一审查轴无法独立完成时返回 `incomplete`。

默认覆盖 `docs/dev/<task-slug>/code-review.md`。任何代码或 Spec 变化后都要重新执行完整双轴审查。Assured 或用户明确要求时，额外归档到 `reviews/code/`。
