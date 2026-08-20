# Dev Implement

直接实现明确的小任务，或按已经确认的 Spec 交付较复杂结果。

一个上下文能完成时不创建额外文档。跨会话、多切片、迁移或 handoff 时，使用可变的 `work.md` 保存当前纵向切片、发现和验证证据；没有指定路径时默认写入 `docs/dev/<task-slug>/work.md`。

发现材料决定、证据缺口、Spec 变化或高风险授权缺口时，Skill 返回中性阻塞类型并停止，不直接编排其它能力。

主要指令见 [`SKILL.md`](SKILL.md)，模板见 [`assets/work-template.md`](assets/work-template.md)，触发用例见 [`evals/`](evals/)。
