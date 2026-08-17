# Dev Workflow

结构化开发的用户入口。它根据当前缺少的是需求决定、可体验证据、稳定 Spec、实现还是审查，选择一个最小能力。

普通明确的小改动不需要使用该入口。显式 `/dev` 或要求“按开发工作流继续”时使用。

该 Skill 可以软组合 `ask-me` 的 `requirements-clarifier` 和 `decision-grill`；未安装时不会复制另一套访谈规则。

主要指令见 [`SKILL.md`](SKILL.md)，触发用例见 [`evals/`](evals/)。
