---
name: author-aw-catalog
description: >-
  当用户要初始化、日常维护或安全删除 AW Catalog Workspace 中的 Plugin Source，并维护 identity、marketplace-source metadata、插件 inventory、依赖 composition、精确 Catalog 版本或聚合验证时使用。插件内部源码修改交给 author-aw-plugin；本 Skill 不评审，也绝不发布 Catalog。
compatibility: 需要 Node.js 22+、当前 PATH 中提供所需 catalog/plugin 作者命令的 aw CLI，以及 aw-plugin-development。
user-invocable: true
metadata:
  short-description: 维护 AW Catalog Workspace、编排安全删除并聚合验证
---

# Author AW Catalog

AW CLI/Core 是 Workspace、metadata、snapshot 和 validator 的机器真值。本 Skill 只拥有 Catalog composition，不复制字段表或发布算法。

## 工作流

1. 明确 `<workspace-root>` 和允许修改范围。运行 `aw --version` 和相关命令的 `--help`。检查 `.aw-workspace.json` 与 `plugins/marketplace-source.json`。缺少合法 Catalog Workspace 时，取得用户对目标根的确认后运行 `aw catalog init --workspace-root <workspace-root>`；已有合法 identity 时不得重建或替换它。
2. 读取 `references/catalog-composition.md`。读取当前 canonical plugin inventory 和每个 manifest `dependencies` 所形成的同 source 图，检查缺失节点、环和目标的反向依赖。维护 marketplace-source metadata、inventory、依赖 composition 和精确 `catalog.version`。版本变更只使用当前 PATH 的 `aw catalog version --help` 与公开 mutation。
3. 用户明确要求删除或移除插件时，Catalog Author 是唯一直接入口，并拥有删除意图和 Workspace 编排。确认其明确给出 `<workspace-root>` 和 `<plugin-name>`，不从 inventory 推测目标。先用当前 inventory 和 manifest 依赖图确认目标与反向依赖；根据目标 Workspace 的版本策略和已有发布证据决定删除是否关联 Catalog version。`aw plugin remove` 不修改 Catalog version；策略或授权不足时报告该未决决定，不猜测 version mutation。把实际单插件删除交给 `author-aw-plugin`，传递 canonical root、明确的 Workspace/插件名、只执行公开删除命令和返回结构化 receipt 的验收条件。Catalog Author 不直接删除插件目录，也不新增 tombstone、retirement metadata 或 release ledger。
4. 新增或修改插件时，把每个插件的 manifest、Skill、extension、MCP/App、config、lifecycle、build、artifact 和其它插件内文件修改交给 `author-aw-plugin`。传递 canonical plugin root、允许路径、意图和验收条件。Catalog Author 不直接修改这些内容。
5. Plugin Author 返回后重新读取 canonical inventory 和 manifest dependency graph。逐个对所有剩余 canonical plugin 运行当前公开的 `aw plugin validate` 和 `aw plugin test`；需要单插件 bundle 或 Git 比较证据时才运行 `aw plugin build` 或 `aw plugin status`。删除成功后不得对已删除目标运行 validate、test、build 或 status。若 inventory 为空，记录 empty inventory，不运行任何 plugin 命令。随后确认依赖图没有缺失节点或环。
6. 运行 `aw catalog build --workspace-root <workspace-root> --json`，再运行 `aw catalog validate <workspace-root>/.aw/catalog --json`。不得手改 snapshot、digest、platform marketplace、ledger、attempt 或 cache。
7. 返回 Workspace identity、metadata/inventory/依赖变化、被委托的插件修改或删除摘要、删除 receipt、逐插件结果、聚合 build/validate 结果和未完成项。绝不运行 `aw catalog publish`。

## 完成条件

- Workspace marker 合法且 identity 未被意外替换。
- inventory 与依赖图中的每个剩余插件已由 Plugin Author 完成其内部修改，并通过所需的单插件验证；empty inventory 不尝试验证已删除对象。
- Catalog build 和 validate 通过；生成物没有手工修改。
- 发布明确标为范围外。
