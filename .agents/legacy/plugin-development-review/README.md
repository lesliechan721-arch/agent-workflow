# Legacy Plugin Development Review

本目录是并行迁移期间旧版插件开发 Review 合同的源码 owner。它保留旧 `create-aw-plugin`、`skill-review`、`review:publish` 和静态报告所需的 schema、validator、inspector、AW bundle、target plan 和摘要 producer。

本 owner 可以单向复用 `plugins/agent-skill-toolkit` 中仍为 canonical 的 Eval 和评分合同。`agent-skill-toolkit` 与 `aw-plugin-development` 不得导入本目录，也不得把本目录内容放入 manifest export、staging 或 runtime bundle。

默认路由仍使用旧工作流。本目录不是新插件 Reviewer 的 runtime dependency。
