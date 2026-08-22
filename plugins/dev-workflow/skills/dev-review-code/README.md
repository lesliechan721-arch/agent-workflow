# Dev Review Code

按两个轴审查已有实现：一条轴检查请求或 Spec 符合度，另一条轴检查正确性、安全性、可维护性和测试可信度。

该 Skill 可以直接调用。Fast、Standard 或未指定保障时，一个 fresh reviewer 覆盖两个轴；Assured 或用户明确要求时，两个 fresh reviewer 分轴完成。任一必需审查无法独立完成时返回 `incomplete`。

默认覆盖 `docs/dev/<task-slug>/code-review.md`。任何代码或 Spec 变化后都重新审查当前完整目标；已有上一份正式报告时，才按需加载复审比较规则。Assured 或用户明确要求时，额外归档到 `reviews/code/`。
