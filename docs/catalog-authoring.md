# AW Catalog Workspace 作者指南

本指南适用于官方和第三方 Catalog Workspace。官方仓库也是普通 Catalog Workspace；它使用相同的公开 Catalog metadata、build、validate、preflight、publisher 和失败恢复合同。当前组合合同是 Plugin Manifest v2、Catalog snapshot schema 5 和 Catalog Sources Config schema 2。

当前 PATH 的 `aw` CLI 和 `@lesliechan721/aw-plugin-core` 是 marker、metadata、snapshot、ledger 和 publication 的机器真值。先运行对应命令的 `--help`，不要从本文复制易变字段或实现发布算法。

## Workspace 和 composition

```text
<workspace>/
  .aw-workspace.json
  plugins/
    marketplace-source.json
    <plugin-name>/.agents-plugin/plugin.json
            ↓ aw catalog build
  .aw/catalog/                    generated development snapshot
```

使用 `aw catalog init --workspace-root <workspace>` 创建 Workspace v1。合法 marker 使用 schema 1、`kind: "aw-catalog-workspace"` 和稳定非空 `workspaceIdentity`。已有合法 identity 不因 metadata、插件或版本变化而替换。

`plugins/marketplace-source.json` 保存 owner、interface 和精确 `catalog.version`。版本只允许稳定 `x.y.z` 或精确 `x.y.z-beta.N`。插件 inventory 来自 canonical `plugins/<name>/.agents-plugin/plugin.json` 集合；同 source runtime dependency 只来自各 manifest `dependencies`。依赖图必须没有缺失节点或环。

Catalog Author 拥有 Workspace identity、metadata、inventory、依赖 composition 和 Catalog exact version。任何 Plugin manifest、Skill、extension、config、lifecycle、build script 或 artifact 内容修改都交给 [Plugin Author](plugin-authoring.md)，返回后再运行聚合验证。不要让底层 plugin 反向依赖 Catalog development layer。

## 状态、版本和聚合验证

先用只读 context 接受显式 `--workspace-root`，或让 CLI 从 cwd 向上选择最近的合法 marker。没有祖先 Workspace 时，context 只报告 Git worktree root 或 cwd 作为 `initialization.suggestedRoot`；它不创建文件。静态 status 使用 schema v2，不运行插件代码、不 build，也不创建 `.aw`：

```bash
aw catalog context --workspace-root "$workspace" --json
aw catalog status --workspace-root "$workspace" --json
```

静态 receipt 分开报告 Workspace、metadata/inventory/dependency graph、Git 和 snapshot 的 `absent|current|stale|invalid` 证据。只有显式 `--preflight` 才运行 committed source HEAD 中的 validator/build 和 publication preparation。

Catalog version 只通过公开 mutation 设置：

```bash
aw catalog version 0.2.0 --workspace-root "$workspace"
aw catalog version --bump patch --workspace-root "$workspace"
```

单插件 `version` 是 artifact identity；`catalog.version` 是整个 snapshot candidate identity。只提高 Catalog version 不能使同一 plugin version 的不同 production bytes 合法。是否需要 plugin bump 由 workspace policy、现有 ledger 和 plugin status 证据决定。

## 删除一个 canonical Plugin Source

Catalog Author 是删除意图和 Workspace 编排 owner。先确认用户明确给出 `<workspace-root>` 和 `<plugin-name>`，读取当前 inventory、目标 manifest dependency graph 和反向依赖。依据 Workspace 版本策略和已有发布证据，决定删除是否关联 Catalog version；`aw plugin remove` 不会修改 version，策略或授权不足时不要猜测 mutation。

实际删除只交给 `author-aw-plugin`：它通过 runtime compatibility check 后，调用公开的 `aw plugin remove <name> --workspace-root <root> --yes --json`。它不直接删除目录、不使用 `--force`、不修改 Catalog metadata、也不 commit、build 或 publish。成功 receipt 返回后，Catalog Author 必须重新读取 inventory 和依赖图；不再验证已删除对象。对每个剩余 canonical plugin 运行 validate/test，并在需要时运行 build/status；若 inventory 为空，记录 empty inventory，不运行 plugin 命令。然后执行聚合验证。普通删除不创建 tombstone、retirement metadata 或 release ledger。

先逐个完成当前 inventory 中插件的 `aw plugin validate`、`aw plugin test` 和必要的 `aw plugin build/status`，再执行：

```bash
aw catalog build --workspace-root "$workspace" --json
aw catalog validate "$workspace/.aw/catalog" --json
```

`aw catalog build` 执行 inventory 中插件的 validator/build code。生成 snapshot、manifest、digest、ledger projection 和 platform marketplace 都不能手改。需要 determinism 证据时，对相同受控 source 输入执行独立 build，并比较 CLI/Core 提供的 digest；文档判断不能替代该证据。删除和日常维护都不会自动 publish；远端 publication 仍只由显式 `publish-aw-catalog` 完成。

## Publication preflight 和授权

远端发布只由用户显式调用 `publish-aw-catalog`。先用 `aw catalog context --json` 检查 CLI 解析的精确目标。Remote 按显式参数、`origin`、唯一 remote 的顺序选择；多个且无 `origin` 时必须显式选择。Branch 使用显式参数或固定默认 `catalog`，绝不从当前 Git branch 推断。

先说明 preflight 会从 committed source HEAD 执行所有插件的公开 validator 和 build code，再运行：

```bash
aw catalog status --workspace-root "$workspace" \
  --preflight --remote <remote> --branch <branch> --json
```

Preflight 从 committed HEAD 的隔离 archive 准备与 publisher 相同的 plan，但不写 attempt、不 push，也不形成持久授权。向用户展示 CLI 返回的 Workspace identity、source HEAD、Catalog version、remote、fetch URL、push URL、branch、parent、tag、snapshot digest、plan ID 和 descriptor digest。只有用户明确授权这一组 exact identity 后，才能执行：

```bash
aw catalog publish --workspace-root "$workspace" \
  --remote <remote> --branch <branch> \
  --expected-descriptor-digest <descriptorDigest> --yes --json
```

Publisher 在远端写入前重新核验 source、remote、tag 和 plan identity。完成后核对 receipt，并验证 remote branch 和 immutable tag。不要在 Agent 内复制 parent、ledger、digest、tag 或 push 算法。

## Published snapshot 和恢复

Published snapshot 绑定完整 release ledger、source identity、plugin artifacts、parent 和 immutable tag。具体 schema 由 Core validator 负责；Author 和 Reviewer 只消费公开 JSON 与验证结果。

第一次远端写入前，CLI 保存版本特定 attempt。发布失败或结果不确定后：

- 不删除、修改或绕过 attempt。
- 不重试同一 Catalog version。
- 使用 Catalog Author 设置更高的新 exact version；必要时按 plugin artifact policy 提高已变化插件版本。
- 对新 identity 重新运行 preflight，并取得新的精确授权。

Catalog 没有同版本 repair。Development snapshot 和 Catalog cache 是可重建弱状态；source marker、metadata 和 source manifests 是强源码。删除弱输出后可重新 build/validate，但这不改变已占用的 publication attempt。

## Source consumption 和信任

Path source 消费本地 development snapshot；Git source 消费 published snapshot。两者都使用 Catalog schema 5，source config 只使用 schema 2。Transport validation 负责安全消费 snapshot；producer、publication 和发布后核验使用 complete validation。安装先计算所选插件的 dependency closure，对闭包内每个 entry 检查 capability compatibility，再只对该闭包执行完整 plugin validation。当前 Workspace 的日常 development source 使用稳定 marker identity 管理：

```bash
aw catalog dev activate --workspace-root "$workspace" --json
aw catalog dev status --workspace-root "$workspace" --json
aw catalog dev deactivate --workspace-root "$workspace" --json
```

`activate` 会在 snapshot absent、stale、invalid 或显式要求时 build/complete validate，再原子提交 managed path source 并 refresh。config 提交后的 refresh 失败返回 partial receipt，不回滚 source；重跑 refresh 或 activate 可以恢复。`status` 不 build、不 refresh；`deactivate` 不删除 `.aw/catalog`。低层 `catalog source add/update` 不能声明 managed ownership。安装测试使用隔离 `AW_HOME`、`AW_CODEX_HOME` 和 `AW_CLAUDE_HOME`：

```bash
aw catalog source add local-example --path "$workspace/.aw/catalog" --primary --json
aw install local-example/example-plugin -p both --json
```

Catalog 可以包含 executable plugin software。添加 source 或安装前检查 source、transport、插件代码和授权边界。Source config 原子提交，但 refresh 和平台安装允许部分失败；使用 receipt、source refresh、`reinstall` 或安全 cleanup 恢复。

## Related documents

- [Plugin authoring](plugin-authoring.md) defines one Plugin Source and plugin commands.
- [Architecture](architecture.md) defines product, snapshot, and publisher boundaries.
- [Plugin maintenance](plugin-maintenance.md) defines this monorepo's CLI/Core/npm/Product Release orchestration.
- [Testing guide](testing.md) defines aggregate build and publication verification.
