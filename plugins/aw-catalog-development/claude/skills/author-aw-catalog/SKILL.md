---
name: author-aw-catalog
description: >-
  当用户要初始化、维护或安全删除 AW Catalog Workspace，维护 identity、metadata、plugin inventory、依赖 composition、精确 Catalog 版本，或把 Workspace 作为本地 development source 时使用。插件内部源码交给 author-aw-plugin；本 Skill 不评审，也绝不发布 Catalog。
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

## Workspace 定位

1. 用户明确给出 Workspace root 时，所有 Catalog 命令都传 `--workspace-root <root>`。
2. 用户给出 canonical `<root>/plugins/<name>` target 时，从该路径推导 `<root>`，并保持所有 Catalog 命令绑定该 root。
3. 其它维护请求让对应公开命令从 cwd 或自己的 target 自动发现最近的合法 Workspace。
4. 只有输入不能唯一确定 root，且公开命令也不能安全自动发现时才询问。不得发明 resolved root、identity 或 receipt。
5. 初始化“当前项目”时，从用户明确 cwd 或明确 Git worktree root 选择安全 root。若两者可能指向不同目标，先询问。运行 `aw catalog init --workspace-root <selected-root> --json`，再用静态 `aw catalog status --workspace-root <selected-root> --json` 确认 marker、identity 和初始 inventory。已有合法 Workspace 只维护，不重建 identity。

## 维护工作流

1. 读取 `references/catalog-composition.md`。用静态 `aw catalog status [--workspace-root <root>] --json` 取得 metadata、inventory、依赖图和 snapshot evidence。维护 `plugins/marketplace-source.json`、inventory、manifest dependency composition 和精确 `catalog.version`；版本 mutation 只使用公开 `aw catalog version`。
2. 插件内 manifest、Skill、extension、MCP/App、config、lifecycle、build 或 artifact 修改都交给 `author-aw-plugin`。传递 canonical `<workspace-root>/plugins/<name>`、允许路径、意图和验收条件；本 Skill 不直接修改插件内部文件。
3. 删除请求由本 Skill 编排。canonical plugin path 可直接确定目标；只给名称时，使用当前 inventory 的唯一匹配。先检查反向依赖，再把实际删除交给 `author-aw-plugin` 的公开删除分支。不得直接删除目录，也不新增 tombstone 或 retirement metadata。
4. Plugin Author 返回后重新运行静态 status。按实际改动风险，对受影响插件及其反向依赖闭包运行 `aw plugin validate`、`aw plugin test`，并只在插件合同需要时运行 `aw plugin build`。删除目标不在闭包中；inventory 为空时不运行 plugin 命令。
5. 普通维护运行：

   ```bash
   aw catalog build [--workspace-root <root>] --json
   aw catalog validate <workspace-root>/.aw/catalog --json
   ```

   Catalog build 覆盖完整 inventory。不得手改 snapshot、digest 或 platform marketplace。
6. 只有用户明确要求把 Workspace 用于本地 CLI 时，改为运行：

   ```bash
   aw catalog dev activate [--workspace-root <root>] --json
   ```

   `activate` 自行完成 Catalog build、complete validate、managed Path source 注册、sync 和 readiness 检查；不要在它前后再组成显式 `build → validate → activate → status` 链。只有用户单独要求查看或停用时才运行 `aw catalog dev status` 或 `aw catalog dev deactivate [--workspace-root <root>] --yes --json`。deactivate 的 schema 4 receipt 返回 inventory v2 的脱敏 `impact`，其中有 installation、lifecycle、config、marketplace 引用或 inventory 不完整时需要 `--yes`。不得调用低层 `catalog source add/update`。
7. 返回实际 Workspace identity、metadata/inventory/依赖变化、插件委托摘要、闭包验证、Catalog build/validate 或 dev activation receipt，以及未完成项。绝不运行 Catalog publication 命令。

## 完成条件

- Workspace marker 合法，identity 未被意外替换。
- 受影响插件及其反向依赖闭包已完成与风险相称的单插件验证；empty inventory 不验证不存在的对象。
- 普通维护的 Catalog build/validate 通过，或显式本地使用的 dev activate receipt 报告 ready；生成物没有手工修改。
- 发布明确标为范围外。
