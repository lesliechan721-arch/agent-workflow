# Legacy Plugin Development Review

本目录是并行迁移期间旧版插件开发 Review 合同的源码 owner。它保留旧 `create-aw-plugin`、`skill-review`、`review:publish` 和静态报告所需的 schema、validator、inspector、AW bundle、target plan 和摘要 producer。

本 owner 可以单向复用 `plugins/agent-skill-toolkit` 中仍为 canonical 的 Eval 和评分合同。`agent-skill-toolkit` 与 `aw-plugin-development` 不得导入本目录，也不得把本目录内容放入 manifest export、staging 或 runtime bundle。

通过公开 `aw` CLI 安装相应插件后，`author-agent-skill`、`review-agent-skill`、`review-agent-workflow`、`author-aw-plugin`、`review-aw-plugin` 和 `review-aw-workflow` 成为默认工作流入口。仓库不把插件源码投影为 `.claude/skills`。旧 `create-aw-plugin` 与 `skill-review` 只保留为手动显式调用的兼容入口。本目录不是新插件 Reviewer 的 runtime dependency。
