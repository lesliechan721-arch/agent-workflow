# Dev Review Spec

只读审查 Spec 是否允许用户知情批准，是否可实现、可验证，并检查它是否已经膨胀成任务清单或自然语言状态机。

结论为 `clean` 或 `blocked`。每个 finding 使用中性处理类型描述，不直接指定后续 Skill。需要持久化且没有指定路径时，默认写入 `docs/dev/<task-slug>/spec-review.md`。

主要指令见 [`SKILL.md`](SKILL.md)，模板见 [`assets/spec-review-template.md`](assets/spec-review-template.md)，触发用例见 [`evals/`](evals/)。
