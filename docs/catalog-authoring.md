# AW Catalog Workspace 作者指南

本指南适用于官方和第三方 Catalog Workspace。当前合同是 Plugin Manifest v3、Catalog snapshot schema 7 和 Catalog Sources Config schema 2。当前 PATH 的 `aw` CLI 和 `@lesliechan721/aw-plugin-core` 是机器真值。

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

snapshot v7 的 release metadata 只含 `state` 和 `sourceHead`。生成 snapshot、manifest、digest 和 marketplace projection 都不能手改。

## Plugin 版本规则

Catalog beta 候选只读取 source metadata、`catalog-v<version>` tag 和 publication journal。

- Plugin beta 和 stable 使用每个当前 Plugin 在目标 branch 的 first-parent 发布历史中最近的 manifest entry。tip 缺少 Plugin 时，plan 按需回溯。没有历史基线，或 stable base 提高时，使用 `beta.1`。
- stable base 相同且 `contentDigest` 相同时，复用现有 beta；contentDigest 改变时使用下一个 `beta.N`。
- stable base 降低时拒绝。
- Stable 对最近历史 entry 检查 version 和 `contentDigest`：contentDigest 改变但 version 没有提高时拒绝；version 降低也拒绝。
- Plugin 移除后重新加入时，继续使用删除前的最近历史基线。

## 发布计划、授权和恢复

远端发布使用两个公开命令。Remote 按显式参数、`origin`、唯一 remote 的顺序选择；多个且无 `origin` 时必须明确选择。Branch 使用显式值或固定默认 `catalog`，不从当前 Git branch 推断。

```bash
aw catalog publish plan --workspace-root "$workspace" \
  --remote <remote> --branch <branch> --json

aw catalog publish apply --workspace-root "$workspace" \
  --remote <remote> --branch <branch> \
  --expected-plan-digest <planDigest> --yes --json
```

plan 从已提交 source HEAD 的隔离 Git repo 验证插件、构建和 snapshot。它返回 Workspace identity、source HEAD、remote identity、branch、parent、tag、snapshot digest 和 `expectedCommit`。`planDigest` 授权 canonical `{ descriptor, expectedCommit }`。snapshot marker 的 Workspace identity 也必须与 descriptor 一致；marker 不进入 snapshot digest。

publication journal 使用 schema v2 `.aw/publish/<version>/journal.json`；pending repo 是同目录的 `repository/`。新 plan 在同父隐藏 temp 目录写完并完整核验后，原子 rename 为正式版本目录。失败不占用正式目录；并发等价 plan 幂等返回，不同 plan 必须提高 Catalog version。旧 `<version>.json` 和 `<version>.repo` 不进入 discovery。

`apply` 只用授权 digest 在 `.aw/publish/*/journal.json` 中唯一定位 journal，不需要 Catalog version 参数。它重新检查当前 Workspace identity、所选 remote 的 identity digest、branch、授权摘要、pending repo 和远端 refs。它不要求当前 source HEAD、clean state 或 metadata version 与 plan 相同，也不重新 build 或 validate source。remote alias 可变化，但 remote identity 和 branch 必须相同。

对于 `prepared` 或 `uncertain`，journal 或 repo 任一缺失或损坏时，停止并提高 Catalog version；不得盲目重建或复用该版本。`published` journal 缺失时，远端 immutable tag 仍占用版本。成功时先原子写 `published` journal，再尽力删除 `repository/`。清理失败返回 published success 和稳定 warning；损坏 residue 不覆盖远端成功事实。相同 journal plan 可对账或续跑；不同 plan 必须提高 Catalog version。journal 是恢复记录，不是跨系统补偿。

publisher 保留 annotated `catalog-v<version>` tag、branch lease、atomic push 和 post-verify。branch 与 tag 都正确时成功；两者都不存在时 atomic push；只有一个缺失时只补该 ref；任一冲突时停止。

`plan --json` 和 `apply --json` 失败时只输出 `{ "ok": false, "code": "<稳定错误码>", "message": "<脱敏说明>" }`，并以退出码 1 结束。`CatalogPublicationInspectionError` 保留其稳定 code；其它 journal、repository 或 remote 失败使用 `catalogPublicationFailed`。JSON 和普通 stderr 都不包含 Workspace、AW_HOME、publication repository、临时目录的绝对路径，也不包含 remote credential、query 或 hash。

`owner.url` 的 host 为 `example.invalid` 时，publish plan 和 apply 以 `catalogMetadataIncomplete` 阻断。先修复 `plugins/marketplace-source.json`，再重新生成 plan。

## Source consumption 和信任

消费端只保存 `catalog-sources.json`、`catalog-state.json` 和内容寻址的 `catalog-store/<logicalIdentitySha256>/<snapshotDigest>/{metadata.json,snapshot/**}`。metadata 保存原始 logical identity。state 中每个 source 只有 `Active` 和 `lastSync`。普通命令只读 Active store，完全离线；没有 Active 时运行 sync。

```bash
aw catalog source sync <id> --json
aw catalog source sync <id> --yes --json
aw catalog source sync <id> --check --json
aw catalog source sync <id> --replace-damaged --yes --json
aw catalog source status <id> --json

aw catalog store status --json
aw catalog store prune --json
aw catalog store prune --yes --json
```

`sync --check` fetch 并验证，但不写 store 或 Active；它可写 `lastSync`，JSON receipt 包含脱敏的 source impact。source status schema 2 的 `compatibility` 为 `null`、`supported` 或带 required/missing capability 的 `unsupported`，且不公开 available capability 全集。普通 sync 在完整验证后原子写 store，再原子切换 Active；失败时 Active 不变。若候选 key 的旧非 Active store entry 已损坏，普通 sync 会在 mutation lock 内确认合法 state 没有任何 Active 引用后，安全 quarantine 并替换它，不要求 repair flag；并发修复直接复用，key 已成为 Active 或 state 无效时 fail closed。候选删除插件、使插件新出现能力不兼容、改变依赖，或传递影响这些插件的现有引用时，sync 仍需要 `--yes`；清单或旧 manifest 不可读时影响为 unknown，也需要确认。`catalog source add/update` 只改 source config；`add --primary` 在主来源切换有引用或 inventory 不完整时需要 `--yes`，remove 有引用或清单不完整时也需要 `--yes`。普通 Git 激活只接受更高 Catalog version；相同 version 不同 digest 和较低 version 都拒绝。明确修改 source config 后的 sync 可确认这些关系。Path source 允许内容变化。

Store prune 是显式恢复工具，不是自动 GC。默认命令和 `--dry-run` 都只预览；只有 `--yes` 删除。只有仍配置 source 的 Active pointer 受保护；已删除 source 的 pointer 公开为 orphan，并按普通 inactive entry 保留 30 天。相同 store key 仍被其它已配置 source 的 Active 使用时，active 优先并继续受保护。它也保留 30 天内的其它非 Active 正式 entry，并保留 24 小时内的 staging、replacement、quarantine 和 delete claim。老 quarantine 只有在可以确定对应 canonical key，且该正式 entry 完整健康时才删除。损坏 state、未知目录、符号链接、unsafe node、验证失败和 foreign 内容全部 fail closed。实际删除与 Active activation 共享现有 AW_HOME mutation lock。它在锁内对每个待删除 item 重新确认节点、identity、Active 和 retention；证据漂移或 rename 失败时报告 stale 并保留。确认通过后，它先把精确节点原子 rename 为同一安全父目录的唯一 `.delete-<uuid>.tmp` claim，再只递归删除 claim。claim 删除失败会返回 partial，并保留严格命名的弱 residue；其安全普通目录树超过 24 小时后，可再次运行 prune 清理。被删除的非 Active 弱 snapshot 可通过 source sync 重建。

Active store 损坏时，Git source 使用当前 transport 配置获取 `Active.resolvedCommit`，并只在 logical identity、snapshot digest、manifest digest 和 commit 全部匹配时修复旧 key；source config 不变。CLI 修复后继续普通 sync，TUI 修复成功后停止。旧 commit 不可取得，或 Path 当前内容不是旧 key 时，命令返回 replace-required。只有 `--replace-damaged --yes` 或 TUI 的独立替换 Review 可以使用已绑定的当前候选。替换执行前重查 source config、候选、Active 和旧 entry 仍损坏；它只跳过无法完成的旧版本比较，未经已验证的 source config 变化仍不能改变 logical identity。

当前 Workspace 的 development source 使用：

```bash
aw catalog dev activate --workspace-root "$workspace" --yes --json
aw catalog dev status --workspace-root "$workspace" --json
aw catalog dev deactivate --workspace-root "$workspace" --yes --json
```

`activate` build、complete validate、注册 managed Path source 并 sync。`dev status` 只读取 snapshot、source/path 和 Active digest；schema 4 receipt 的 `active.compatibility` 为 `null`、`supported` 或带 required/missing capability 的 `unsupported`。`deactivate` 不删除 `.aw/catalog`，只安全移除精确的 managed Path source。停用检测到 installation、lifecycle、config 或 marketplace 引用，或 inventory 不完整时需要 `--yes`；schema 4 receipt 返回 inventory v2 的脱敏 `impact`。primary source 停用把 remove 和 primary change 作为同一个 impact 和最终 config 提交。

Git source 保持非交互，保留 timeout、protocol/ref/temp validation、credential URL 拒绝和诊断脱敏。`AW_CATALOG_REMOTE_TIMEOUT_MS` 接受 `0` 或 `100..300000`。完整 resolve 默认 180000 ms；ref probe 最多 30000 ms；`0` 表示无 deadline。每次 probe 或完整 resolve 内的命令共享各自 deadline，probe 后的完整 resolve 使用新的 deadline。消费端只清理危险的 repository、worktree、index 和 object 环境变量；它保留 credential helper、SSH agent、自定义 SSH、proxy 和 `insteadOf`。

TUI 的自动检查和“重新检查”先做轻量 Git ref probe，commit 未变时不 fetch；“完整验证”强制完整 resolve。完整 freshness candidate 可在当前 session 内复用于普通 Review preparation，但必须继续匹配 session token、source config fingerprint 和 Active store key。Execute 总是重新 resolve。这个复用不持久 Candidate，也不改变 Active 或 Status。候选要求当前 AW 不支持的 capability 时，TUI 显示 missing capability IDs，保留旧 Active，并阻止普通 update。

Snapshot v6 首次上线使用空的新 branch state，不读取旧 snapshot state。旧 `AW_HOME` 不迁移或自动删除；开发环境使用新的 `AW_HOME`，或手工清理后重新 sync。

## 删除一个 canonical Plugin Source

Catalog Author 先确认用户明确给出 `<workspace-root>` 和 `<plugin-name>`，读取 inventory、目标 dependency graph 和反向依赖。实际删除使用 `aw plugin remove <name> --workspace-root <root> --yes --json`。它不直接删除目录、不使用 `--force`、不修改 Catalog metadata、不 commit、build 或 publish。成功后重新验证剩余 inventory；空 inventory 不运行 plugin 命令。删除不自动 publish。

## Related documents

- [Plugin authoring](plugin-authoring.md) defines one Plugin Source and plugin commands.
- [Architecture](architecture.md) defines product, snapshot, source, and publisher boundaries.
- [Plugin maintenance](plugin-maintenance.md) defines this monorepo's CLI/Core/npm/Product Release orchestration.
- [Testing guide](testing.md) defines aggregate build and publication verification.
