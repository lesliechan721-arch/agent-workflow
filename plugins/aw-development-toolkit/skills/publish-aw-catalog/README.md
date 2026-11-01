# Publish AW Catalog

通过显式用户宏发布 AW Catalog，并对具体 publication plan 取得授权。

请在客户端显式调用 `$publish-aw-catalog`，例如：“$publish-aw-catalog 发布当前 Catalog，先展示计划。”可以指定 Workspace root、remote 或 branch；省略时由 CLI 解析最近 Workspace、origin 或唯一 remote，以及 catalog 分支。不能唯一解析时才需要补充目标。

生成计划会读取远端 refs，并从已提交源码执行插件和 Catalog 构建。计划展示解析后的目标及完整摘要；只有用户授权该计划后才写入远端。初始请求和其它计划的授权不能替代这一确认。

普通自然语言请求不会自动启动本宏。开发、来源解析与本地验证使用 `develop-aw`；专项只读评审由用户显式启动 `review-agent-skill`。失败或结果不确定时按 CLI 的同一计划恢复要求处理，不手工修改发布状态。
