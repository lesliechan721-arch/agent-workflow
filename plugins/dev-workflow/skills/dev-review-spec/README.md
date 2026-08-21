# Dev Review Spec

独立、只读审查 Spec 是否允许用户知情批准，是否可实现、可验证，并检查它是否膨胀成任务清单或自然语言状态机。

该 Skill 可以直接调用。正式结论必须来自一个 fresh reviewer 子代理；当前上下文只准备输入和保存结果。无法创建独立上下文时返回 `incomplete`。

默认覆盖 `docs/dev/<task-slug>/spec-review.md`，并在报告中绑定目标 revision。Git 保存普通历史；Assured 或用户明确要求时额外归档到 `reviews/spec/`。
