# Catalog composition Review

只评审跨插件集合与发布单元的 composition。机器结构和状态字段以静态 `aw catalog context/status --json`、Core validator 的既有输出和目标 workspace 的现有文件为真值。

高价值检查面是稳定 Workspace identity、metadata 与生成 projection 的一致性、plugin inventory 完整性、manifest dependency 的缺失节点或环、Catalog/plugin exact version 与已有发布证据的冲突、现有 snapshot 是否能绑定当前 source、现有 ledger 是否能绑定 published projection，以及 CLI 解析的 remote/branch 是否明确。snapshot 为 absent、current、stale 或 invalid 都是静态证据；只说明已观察状态，不以它替代 build。

Determinism 需要两次受控 build 或等价的既有 digest 证据。只读 Review 不生成该证据。缺少时报告 unknown，不推断通过。

单插件内部 manifest、Skill、extension、config、lifecycle、artifact 或 Release Check finding 交给 `review-aw-plugin`。跨插件用户结果、handoff 和业务 owner 交给 `review-aw-workflow`。Catalog Reviewer 只消费必要摘要，并保留 finding 的唯一 owner。
