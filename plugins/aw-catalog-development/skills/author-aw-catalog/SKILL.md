---
name: author-aw-catalog
description: >-
  当用户要初始化或日常维护 AW Catalog Workspace 的 identity、marketplace-source metadata、插件 inventory、依赖 composition、精确 Catalog 版本或聚合验证时使用。插件内部源码修改交给 author-aw-plugin；本 Skill 不评审，也绝不发布 Catalog。
compatibility: 需要 Node.js 22+、当前 PATH 中提供所需 catalog/plugin 作者命令的 aw CLI，以及 aw-plugin-development。
user-invocable: true
metadata:
  short-description: 维护 AW Catalog Workspace 并聚合验证
---

# Author AW Catalog

AW CLI/Core 是 Workspace、metadata、snapshot 和 validator 的机器真值。本 Skill 只拥有 Catalog composition，不复制字段表或发布算法。

## 工作流

1. 明确 `<workspace-root>` 和允许修改范围。运行 `aw --version` 和相关命令的 `--help`。检查 `.aw-workspace.json` 与 `plugins/marketplace-source.json`。缺少合法 Catalog Workspace 时，取得用户对目标根的确认后运行 `aw catalog init --workspace-root <workspace-root>`；已有合法 identity 时不得重建或替换它。
2. 读取 `references/catalog-composition.md`。维护 marketplace-source metadata、插件目录 inventory、manifest `dependencies` 所形成的同 source 图，以及精确 `catalog.version`。版本变更只使用当前 PATH 的 `aw catalog version --help` 与公开 mutation。
3. 新增、删除或修改插件时，把每个插件的 manifest、Skill、extension、MCP/App、config、lifecycle、build、artifact 和其它插件内文件修改交给 `author-aw-plugin`。传递 canonical plugin root、允许路径、意图和验收条件。Catalog Author 不直接修改这些内容。
4. 插件 Author 返回后，逐插件运行当前公开的 `aw plugin validate`、`aw plugin test` 和 `aw plugin status`。需要单插件 bundle 证据时运行 `aw plugin build`。然后检查 inventory 和依赖图没有缺失节点或环。
5. 运行 `aw catalog build --workspace-root <workspace-root> --json`，再运行 `aw catalog validate <workspace-root>/.aw/catalog --json`。不得手改 snapshot、digest、platform marketplace、ledger、attempt 或 cache。
6. 返回 Workspace identity、metadata/inventory/依赖变化、被委托的插件修改摘要、逐插件结果、聚合 build/validate 结果和未完成项。绝不运行 `aw catalog publish`。

## 完成条件

- Workspace marker 合法且 identity 未被意外替换。
- inventory 与依赖图中的每个插件已由 Plugin Author 完成其内部修改，并通过所需的单插件验证。
- Catalog build 和 validate 通过；生成物没有手工修改。
- 发布明确标为范围外。
