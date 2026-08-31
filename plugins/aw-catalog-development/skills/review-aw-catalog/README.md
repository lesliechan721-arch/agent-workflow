# review-aw-catalog

严格只读评审 AW Catalog Workspace 的 identity、metadata、inventory、依赖图、版本一致性和已有 snapshot evidence。

它使用静态 `catalog status --json`，并精确区分 `absent`、`current`、`stale` 和 `invalid`。需要时只验证已经存在的 snapshot；不会运行 plugin validate/test/build、Catalog build、development/source mutation、publish plan/apply 或网络操作。

单插件内部质量只消费调用方已提供且可验证的 `review-aw-plugin` 摘要；没有该摘要时，只输出独立后续 Review target，不在当前 Catalog Review 中启动 Plugin Review。跨插件业务 workflow 交给 `review-aw-workflow`。
