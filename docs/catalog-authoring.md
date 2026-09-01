# AW Catalog Workspace 作者指南

本指南适用于官方和第三方 Catalog Workspace。当前合同是 Plugin Manifest v2、Catalog snapshot schema 6 和 Catalog Sources Config schema 2。当前 PATH 的 `aw` CLI 和 `@lesliechan721/aw-plugin-core` 是机器真值。

## Workspace 和聚合验证

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

`plugins/marketplace-source.json` 保存 owner、interface 和精确 `catalog.version`。版本只允许稳定 `x.y.z` 或精确 `x.y.z-beta.N`。插件 inventory 来自 canonical `plugins/<name>/.agents-plugin/plugin.json`；同 source dependency 只来自 manifest `dependencies`，且依赖图不能有缺失节点或环。

每个 Catalog 命令自行从 `--workspace-root` 或 cwd 向上定位最近的合法 marker。`aw catalog status --workspace-root "$workspace" --json` 是静态命令：它读取 Workspace、metadata、inventory、依赖图、Git 状态和 snapshot evidence，不 build、fetch 或运行插件代码。

Catalog version 只通过公开 mutation 设置：

```bash
aw catalog version 0.2.0 --workspace-root "$workspace"
aw catalog version --bump patch --workspace-root "$workspace"
```

单插件 `version` 是 artifact identity；`catalog.version` 是整个 snapshot identity。先对每个当前 canonical plugin 运行 `aw plugin validate`、`aw plugin test` 和必要的 `aw plugin build/status`，再运行：

```bash
aw catalog build --workspace-root "$workspace" --json
aw catalog validate "$workspace/.aw/catalog" --json
```

第三方公开 `aw catalog build` 默认只 advisory，不使用 `--strict-requirements`。本仓库官方入口 `pnpm build` 必须使用 `--strict-requirements` 语义；`release:verify:catalog:core` 通过该 build 覆盖 strict 门禁。

snapshot v6 的 release metadata 只含 `state` 和 `sourceHead`。生成 snapshot、manifest、digest 和 marketplace projection 都不能手改。

## Plugin 版本规则

Catalog beta 候选只读取 source metadata、`catalog-v<version>` tag 和 publication journal。

- Plugin beta 和 stable 都只使用目标 branch 的上一份 manifest 作为唯一相邻基线。beta 没有上一份 manifest，或 stable base 提高时，使用 `beta.1`。
- stable base 相同且 `contentDigest` 相同时，复用现有 beta；contentDigest 改变时使用下一个 `beta.N`。
- stable base 降低时拒绝。
- Stable 只对上一份 manifest 仍存在的同名 Plugin 检查 version 和 `contentDigest`：contentDigest 改变但 version 没有提高时拒绝；version 降低也拒绝。
- Plugin 移除后重新加入时，不保留历史。

## 发布计划、授权和恢复

远端发布使用两个公开命令。Remote 按显式参数、`origin`、唯一 remote 的顺序选择；多个且无 `origin` 时必须明确选择。Branch 使用显式值或固定默认 `catalog`，不从当前 Git branch 推断。

```bash
aw catalog publish plan --workspace-root "$workspace" \
  --remote <remote> --branch <branch> --json

aw catalog publish apply --workspace-root "$workspace" \
  --remote <remote> --branch <branch> \
  --expected-plan-digest <planDigest> --yes --json
```

plan 从已提交 source HEAD 的隔离 Git repo 验证插件、构建和 snapshot。它返回并要求授权 Workspace identity、source HEAD、remote identity、branch、parent、tag 和 snapshot digest。`apply` 在远端写入前再次核验这些身份。

publication journal 是 version-scoped 强恢复和门禁状态，状态为 `prepared`、`uncertain` 或 `published`。隔离 repo 是 pending plan 的可重建暂存 artifact，但同版本恢复依赖它。对于 `prepared` 或 `uncertain`，journal 或 repo 任一缺失或损坏时，停止并提高 Catalog version；不得盲目重建或复用该版本。`published` journal 缺失时，远端 immutable tag 仍占用版本。首次远端写入前保存已验证隔离 repo；成功后删除 repo 并保留 JSON journal。相同 journal plan 和版本可对账或续跑；不同 plan 必须提高 Catalog version。journal 是恢复记录，不是跨系统补偿。

publisher 保留 annotated `catalog-v<version>` tag、branch lease、atomic push 和 post-verify。branch 与 tag 都正确时成功；两者都不存在时 atomic push；只有一个缺失时只补该 ref；任一冲突时停止。

`owner.url` 的 host 为 `example.invalid` 时，publish plan 和 apply 以 `catalogMetadataIncomplete` 阻断。先修复 `plugins/marketplace-source.json`，再重新生成 plan。

## Source consumption 和信任

消费端只保存 `catalog-sources.json`、`catalog-state.json` 和内容寻址的 `catalog-store/<logicalIdentitySha256>/<snapshotDigest>/{metadata.json,snapshot/**}`。metadata 保存原始 logical identity。state 中每个 source 只有 `Active` 和 `lastSync`。普通命令只读 Active store，完全离线；没有 Active 时运行 sync。

```bash
aw catalog source sync <id> --json
aw catalog source sync <id> --check --json
aw catalog source status <id> --json
```

`sync --check` fetch 并验证，但不写 store 或 Active；它可写 `lastSync`。普通 sync 在完整验证后原子写 store，再原子切换 Active；失败时 Active 不变。`catalog source add/update` 只改 source config。Git 回退时改 ref 后再 sync；Path source 损坏时恢复目录后再 sync。

当前 Workspace 的 development source 使用：

```bash
aw catalog dev activate --workspace-root "$workspace" --json
aw catalog dev status --workspace-root "$workspace" --json
aw catalog dev deactivate --workspace-root "$workspace" --json
```

`activate` build、complete validate、注册 managed Path source 并 sync。`dev status` 只读取 snapshot、source/path 和 Active digest。`deactivate` 不删除 `.aw/catalog`，只安全移除精确的 managed Path source。

Git source 保持非交互，保留 timeout、protocol/ref/temp validation、credential URL 拒绝和诊断脱敏。消费端只清理危险的 repository、worktree、index 和 object 环境变量；它保留 credential helper、SSH agent、自定义 SSH、proxy 和 `insteadOf`。

Snapshot v6 首次上线使用空的新 branch state，不读取旧 snapshot state。旧 `AW_HOME` 不迁移或自动删除；开发环境使用新的 `AW_HOME`，或手工清理后重新 sync。

## 删除一个 canonical Plugin Source

Catalog Author 先确认用户明确给出 `<workspace-root>` 和 `<plugin-name>`，读取 inventory、目标 dependency graph 和反向依赖。实际删除使用 `aw plugin remove <name> --workspace-root <root> --yes --json`。它不直接删除目录、不使用 `--force`、不修改 Catalog metadata、不 commit、build 或 publish。成功后重新验证剩余 inventory；空 inventory 不运行 plugin 命令。删除不自动 publish。

## Related documents

- [Plugin authoring](plugin-authoring.md) defines one Plugin Source and plugin commands.
- [Architecture](architecture.md) defines product, snapshot, source, and publisher boundaries.
- [Plugin maintenance](plugin-maintenance.md) defines this monorepo's CLI/Core/npm/Product Release orchestration.
- [Testing guide](testing.md) defines aggregate build and publication verification.
