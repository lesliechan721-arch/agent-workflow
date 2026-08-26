# Dev Workflow

可选的结构化开发宏入口。它选择 Fast、Standard 或 Assured，并根据已有决策、Prototype、Spec、Review、`work.md` 和代码状态选择当前阶段。

每个专业 Skill 都可以直接调用。只有用户希望自动选路、跨阶段继续或恢复一个已有任务时使用本入口。

入口组合：

- `decision-grill`：通过讨论解决材料决定。
- `decision-prototype`：通过体验或实验取得决策证据。
- `dev-spec`、`dev-review-spec`、`dev-implement`、`dev-review-code`：完成规格、审查、实现与交付。

Review 的根路由只消费 `clean / blocked / incomplete / stop`。只有已有 blocked 正式 Review 且用户授权自动继续时，才按需加载一次修复与完整复审的条件规则。

Standard 和 Assured 没有仓库约定时，默认任务目录为 `docs/dev/<task-slug>/`。
