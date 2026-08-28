# review-aw-catalog

严格只读评审 AW Catalog Workspace 的 identity、metadata、inventory、依赖图、版本一致性和已有发布证据。

它不会运行 build、preflight 或 publish。单插件内部质量交给 `review-aw-plugin`；跨插件业务 workflow 交给 `review-aw-workflow`。
