# Dev Review Code

独立双轴审查已有实现：一条轴检查请求或 Spec 符合度，另一条轴检查正确性、安全性、可维护性和测试可信度。

该 Skill 可以直接调用。正式结论必须并行使用两个 fresh reviewer 子代理；当前上下文只固定目标、调度和保存结果。任一审查轴无法独立完成时返回 `incomplete`。

默认覆盖 `docs/dev/<task-slug>/code-review.md`，并绑定 Base、Head 或精确 diff revision。Git 保存普通历史；Assured 或用户明确要求时额外归档到 `reviews/code/`。
