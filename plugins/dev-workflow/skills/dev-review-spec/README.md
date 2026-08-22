# Dev Review Spec

独立、只读审查 Spec 是否允许用户知情批准，是否可实现、可验证，并检查它是否规定过度。

该 Skill 可以直接调用。正式结论由一个 fresh reviewer 完成；无法创建独立 reviewer 时返回 `incomplete`。

默认覆盖 `docs/dev/<task-slug>/spec-review.md`。报告绑定当前 Spec 版本。Spec 修订或补证后重新执行完整审查；已有上一份正式报告时，才按需加载复审比较规则。Assured 或用户明确要求时，额外归档到 `reviews/spec/`。
