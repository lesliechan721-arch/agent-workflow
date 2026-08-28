---
name: author-aw-catalog
description: >-
  当用户要初始化当前项目、维护或安全删除 AW Catalog Workspace 中的 Plugin Source，维护 identity、metadata、inventory、依赖 composition、精确 Catalog 版本，或把当前 Catalog 作为 CLI source 时使用。插件内部源码交给 author-aw-plugin；本 Skill 不评审，也绝不发布 Catalog。
compatibility: 需要 Node.js 22+、可用的 aw CLI，以及 aw-plugin-development。
user-invocable: true
metadata:
  short-description: 维护 AW Catalog Workspace、编排安全删除并聚合验证
---

# Author AW Catalog

AW CLI/Core 是 Workspace、metadata、snapshot 和 validator 的机器真值。本 Skill 只拥有 Catalog composition，不复制字段表或发布算法。

## Runtime gate

在本 Skill 的每次调用中，在首次 AW 命令前，从平台提供的本 Skill 实际根取得 `<skill-root>`：使用 Skill locator 或当前加载的 `SKILL.md` 所在根，绝不从 cwd 猜测。随后运行：

```bash
aw self check --from <skill-root> --json
```

找不到 `aw` 或 `aw self check` 命令时立即停止，并精确报告 `missing: aw` 或 `missing: aw self check`。若 JSON 的 `ok` 为 `false`，立即停止并逐项报告 `missingCapabilities`；不添加 `--require`、不维护 Skill 内 capability 列表，也不固定 executable。

## 工作流

1. 运行 `aw catalog context --json`。若 `workspace.found`，只使用 JSON 给出的绝对 `workspace.root`。已有 Workspace 只维护，不重建 identity。若找不到 Workspace，且用户明确要求“初始化当前项目”，使用 `initialization.suggestedRoot` 运行 `aw catalog init --workspace-root <initialization.suggestedRoot> --json`，再读取 context。其它找不到或歧义的 root 才向用户询问目标。
2. 读取 `references/catalog-composition.md`，并用 `aw catalog status --workspace-root <workspace.root> --json` 取得当前 inventory 和依赖图。维护 marketplace-source metadata、inventory、依赖 composition 和精确 `catalog.version`；版本 mutation 只使用公开的 `aw catalog version`。
3. 插件内 manifest、Skill、extension、MCP/App、config、lifecycle、build 或 artifact 修改都交给 `author-aw-plugin`。传递 CLI 解析的 canonical `<workspace.root>/plugins/<name>`、允许路径、意图和验收条件；本 Skill 不直接修改插件内部文件。
4. 删除请求由本 Skill 接收和编排。以用户明确请求中的 canonical plugin path 推断目标；只给出名称时，以当前 inventory 中唯一的名称推断。名称不唯一时才询问。先检查反向依赖；把实际删除交给 `author-aw-plugin` 的公开删除分支，并要求其返回结构化 receipt。不得直接删除目录，也不新增 tombstone、retirement metadata 或 release ledger。
5. Plugin Author 返回后重新读取 status 和 dependency graph。只对受影响插件及其反向依赖闭包运行 `aw plugin validate` 和 `aw plugin test`；删除目标不在闭包中。inventory 为空时记录 empty inventory，不运行 plugin 命令。Catalog build 仍覆盖完整 inventory。
6. 运行 `aw catalog build --workspace-root <workspace.root> --json`，再运行 `aw catalog validate <workspace.root>/.aw/catalog --json`。不得手改 snapshot、digest、platform marketplace、ledger、attempt 或 cache。
7. 用户要求“把当前 Catalog 作为 CLI source”时，运行 `aw catalog dev activate --workspace-root <workspace.root> --json`。只用 `aw catalog dev status` 和 `aw catalog dev deactivate` 查看或停用这个 source；绝不调用低层 source add/update。
8. 返回 CLI 解析的 Workspace identity、metadata/inventory/依赖变化、委托摘要和 receipt、闭包验证、Catalog build/validate、development source receipt 与未完成项。绝不运行 `aw catalog publish`。

## 完成条件

- Workspace marker 合法且 identity 未被意外替换。
- 受影响插件及其反向依赖闭包已通过所需的单插件验证；empty inventory 不尝试验证已删除对象。
- Catalog build 和 validate 通过；生成物没有手工修改。
- 发布明确标为范围外。
