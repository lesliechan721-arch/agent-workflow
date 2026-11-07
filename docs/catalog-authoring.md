# AW Catalog Workspace 作者指南

> [!NOTE]
> 本文件已迁移。Catalog 工作区初始化、构建、本地调试与发布教程唯一权威正文见：
> [Catalog 作者指南](authoring/catalog.md)
> 外部 Catalog Snapshot schema 7 规范、发布计划与 Journal 状态机完整合同见 [外部 Catalog 参考合同](reference/catalog.md)；官方发版见 [官方发布与失败恢复指南](maintainers/release.md)。

## Workspace 和聚合验证

Catalog Workspace 目录结构、标记文件与聚合构建见 [Catalog 作者指南：Workspace 结构与初始化](authoring/catalog.md#2-catalog-workspace-结构与初始化)。

## Plugin 版本规则

单插件与快照版本递增概览见 [Catalog 作者指南：聚合验证与快照构建](authoring/catalog.md#3-聚合验证与快照构建)；基于 first-parent 发布历史的 Plugin beta/stable 版本决策完整算法与拒绝条件见 [外部 Catalog 参考合同：Plugin 历史版本决策与发布规则](reference/catalog.md#3-plugin-历史版本决策与发布规则)。

## 发布计划、授权和恢复

两阶段发布计划审查（Plan）与显式授权应用（Apply）流程见 [Catalog 作者指南：远端发布计划、授权与应用](authoring/catalog.md#5-远端发布计划授权与应用)；Journal 状态机与核心门禁见 [外部 Catalog 参考合同：发布计划与 Journal 状态机](reference/catalog.md#4-发布计划journal-与失败恢复合同)。

## Source consumption 和信任

来源配置 Schema 2、Active 快照存储与离线安全回收见 [外部 Catalog 参考合同：来源消费层级](reference/catalog.md#5-catalog-来源消费层级与外部后果说明) 与 [Catalog 来源架构说明](maintainers/architecture/catalog-sources.md)。

## 删除一个 canonical Plugin Source

删除插件源码命令与反向依赖保护见 [开发你的第一个插件：安全删除插件](authoring/first-plugin.md#5-安全删除插件)。

## Related documents

- [Catalog 作者指南](authoring/catalog.md)
- [开发你的第一个插件](authoring/first-plugin.md)
- [外部 Catalog 参考合同](reference/catalog.md)
- [Catalog 来源架构说明](maintainers/architecture/catalog-sources.md)
- [官方发布与失败恢复指南](maintainers/release.md)
