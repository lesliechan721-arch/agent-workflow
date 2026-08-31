# Catalog composition Review

只评审跨插件集合与发布单元的 composition。机器结构和状态以静态 `aw catalog status --json`、现有 source 文件和按需运行的现有 snapshot validation 为真值。

高价值检查面是稳定 Workspace identity、metadata、plugin inventory、manifest dependency 的缺失节点或环、Catalog/plugin exact version，以及现有 snapshot 与当前 source 的关系。status 的 `absent/current/stale/invalid` 是完整的静态分类；不要从本地 Git remote 或 current branch 推断 publication target。

`current` 证明已有 snapshot 当前绑定 source；`stale` 只证明旧 snapshot 自身可能有效；`absent` 没有 projection evidence；`invalid` 是现有 snapshot validation failure。只读 Review 不 build 或修复任何状态。

Determinism 需要两次受控 build 或等价的既有 digest evidence。只读 Review 不生成该证据，缺少时报告 unknown。

单插件内部 manifest、Skill、extension、config、lifecycle、artifact 或 Release Check finding 不在当前 Catalog Review 中启动 `review-aw-plugin`。只有调用方已提供、且可绑定同一 Workspace root 与 status inventory 中 canonical 插件名称/版本的既有 Plugin Review 摘要时，Catalog Reviewer 才消费必要内容。Plugin Reviewer 保留该 finding 的 owner；Catalog Reviewer 只报告它的 Catalog composition 影响。摘要缺失、绑定不完整或不匹配时，只输出该 canonical 插件路径和 `review-aw-plugin` 作为独立后续 Review target，并停止该插件内部范围。跨插件用户结果、handoff 和业务 owner 交给 `review-aw-workflow`。Catalog Reviewer 保留 Catalog finding 的唯一 owner。
