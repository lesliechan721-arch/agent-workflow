# review-aw-catalog

严格只读评审 AW Catalog Workspace 的 identity、metadata、inventory、依赖图、版本一致性和已有 snapshot/发布证据。

它先用 `aw catalog context --json` 定位 root；合法 marker 下的 degraded Workspace 仍可进行可得的只读检查，非阻断 workspace-content issue 会成为 finding。随后它只读取静态 status，明确报告 snapshot 是 absent、current、stale 或 invalid。需要时只读验证已存在 snapshot；不会运行 plugin test/build、Catalog build、preflight、publish 或任何 mutation。单插件内部质量交给 `review-aw-plugin`；跨插件业务 workflow 交给 `review-aw-workflow`。
