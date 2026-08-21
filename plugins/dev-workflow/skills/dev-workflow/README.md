# Dev Workflow

结构化开发的用户入口。它先选择 Fast、Standard 或 Assured 保障等级，再根据现有决策记录、Prototype、Spec、Review、work 和代码状态，从最早未完成阶段继续。

普通明确的小改动不需要使用该入口。用户明确要求按开发工作流组织任务，或需要跨阶段恢复时使用。

Standard 和 Assured 没有仓库约定时，默认任务目录为 `docs/dev/<task-slug>/`。入口统一确定路径并把它传给后续专业能力。

主要指令见 [`SKILL.md`](SKILL.md)，触发用例见 [`evals/`](evals/)。
