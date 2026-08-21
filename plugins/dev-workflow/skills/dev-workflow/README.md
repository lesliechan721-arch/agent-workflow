# Dev Workflow

可选的结构化开发宏入口。它选择 Fast、Standard 或 Assured，并根据已有决策、Prototype、Spec、Review、`work.md` 和代码状态选择当前阶段。

每个专业 Skill 都可以直接调用，不需要先经过本入口。只有用户希望自动选路、跨阶段继续或恢复一个已有任务时使用。

Standard 和 Assured 没有仓库约定时，默认任务目录为 `docs/dev/<task-slug>/`。本入口不创建额外状态文件。
