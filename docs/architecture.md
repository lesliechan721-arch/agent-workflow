# Architecture

本文件定义 CLI 的稳定产品合同和模块边界。TypeScript 实现方式见[编码约定](coding-conventions.md)，测试选择见[测试指南](testing.md)，插件作者工作流见[插件维护指南](plugin-maintenance.md)。

## 设计边界

- AW 是个人本地工具。一个 `AW_HOME` 写锁足以保护强配置；不要为未证明的并发增加全局协调协议。
- Catalog 是公开产品，支持 Git 和本地路径等多个来源。来源独立解析、独立报告错误；一个来源失败不要求其它来源回滚，也不要求 npm 与 Git 形成强一致事务。
- `catalog-sources.json` 和 plugin config 是强配置。它们必须以原子替换提交。插件输出、依赖现场、lifecycle snapshot、Catalog cache 和 release prepared 目录都是弱状态，可删除和重建。
- 外部平台和用户编辑的插件目录不受 AW 完全控制。写操作应提供可观察结果和恢复入口，不建立无法兑现的全局补偿或完全正确保证。

## CLI Source Layout (`packages/cli/src`)

- `commands/write-commands.ts` 是 `install`、`upgrade`、`reinstall`、`uninstall`、`cleanup` 的公开写入口。
- `commands/rebuild-command.ts` 解析当前 Catalog、依赖和现场状态，并交给统一 rebuild 流程。
- `commands/rebuild-operations.ts` 编排 ownership 检查、清理、平台写入、lifecycle 和完成后检查。
- `commands/rebuild-integration.ts` 把插件能力转换成平台原生写入和 AW-owned 组件。
- `commands/status-v4.ts` 读取多来源 Catalog、live ownership 和平台组件，生成 status v4 和控制台输入。
- `commands/dependency-operation-plan.ts` 只生成一次命令内的依赖执行顺序；它不是持久安装记录。
- `utils/ownership.ts` 定义 owner marker、组件检查和安全删除边界。
- `utils/lifecycle-active-store.ts` 保存下一次 uninstall lifecycle 所需的弱状态。
- `utils/multi-source-catalog.ts` 和 `utils/catalog-source-cache.ts` 解析 schema 1 Git/path source，并管理可重建的本地快照。
- `utils/plugin-config.ts` 与 `utils/plugin-config-write.ts` 管理 namespaced AW config store 和 config v4 输出。
- `output/command-receipt.ts` 生成五个写命令的 receipt v4。
- `authoring/` 是 `aw plugin init`、`add-skill`、`validate` 和 `status` 的确定性作者实现；它随 CLI tarball 发布，运行时不读取仓库 `.agents` 或插件 Skill root。

### Module Invariants

- renderer 只返回 `ArtifactPlan`，不直接写平台文件。
- 写入前验证 scope、路径边界、目标身份和最终 Skill tree。
- 插件依赖只来自 manifest `dependencies`，只在同一 source 内解析。依赖图拒绝缺失节点、环和超出既定上限的图；执行顺序是稳定的依赖优先拓扑序。
- live ownership 和实际平台组件是插件存在、清理和 status 的唯一真值。不得新增安装合同存储、第二套安装状态或持久依赖图。
- 配置写入、生命周期和平台写入各自保留最小的本地恢复；它们不组成跨第三方系统的事务。

## Distribution and Runtime State

```text
插件源码
  plugins/<name>/.agents-plugin/plugin.json
  plugins/<name>/skills/**
          ↓ pnpm build
本地 schema 4 Catalog snapshot
  packages/cli/plugins-dist/
          ↓ Catalog 发布
Git Catalog source
          ↓ Git/path source 解析
<AW_HOME>/
  catalog-sources.json                 [强配置]
  plugin-config/**                     [强配置]
  catalog-cache/sources/<sourceId>/{current,last-good}/
  marketplaces/**
  lifecycle-active/**
```

- 源码层是插件作者维护的输入。`evals/**`、正式报告和 `.DS_Store` 不进入 runtime bundle；Skill `README.md` 是 production source。
- `pnpm build` 生成本地 schema 4 snapshot。`packages/cli/dist/`、`packages/cli/plugins-dist/` 和 `.release/` 都是生成目录，不手工修改。
- Catalog 发布时会生成 snapshot 及其必要的 Catalog 内容。`plugin-release-ledger.json` 是 Catalog 产物合同的一部分；插件作者合同由[插件维护指南](plugin-maintenance.md)定义。
- `<AW_HOME>/catalog-sources.json` 缺失时读取内置 `official` source；第一次来源修改才物化该文件。稳定版 CLI 使用 `catalog/latest`，预发布 CLI 使用 `catalog/beta`。

### Portable Agent Skills Distribution

`agent-skills` 是独立 distribution，不是 `PlatformName`，也不改变 marketplace product eligibility。插件通过 `distributions.agentSkills` 显式声明该能力；原生 `skills` 不自动成为 portable source，V1 也不支持 portable-only plugin。

Catalog build 把 portable static Skill、明确选择 `distributions: ["agent-skills"]` 的 `skillRuntimeFiles`，以及 dynamic artifact 的 `runtimeImports` 复制到 consumer bundle。runtime import 带 bundle-local path、digest 和 provider provenance；materialize 运行时不读取其它插件 bundle，也不导入其它 renderer 的输出。

Portable materializer 使用调用方提供的同 source Catalog plugin set，解析依赖优先的完整 closure，读取现有 scope config，并合并 static 与 `agent-skills.skill` dynamic candidates。合并顺序是 `sourceDirs → distribution skillRuntimeFiles → renderer content.files`。任何无效 Skill、名字冲突、未解析模板或 sensitive config 明文都阻止整次输出。物化只使用操作级临时目录，并写 schema 1 `.aw-materialization.json`；它不创建 installed state、持久 current cache、Agent registry 或新锁。

`aw skill install` 先物化和 Review 完整候选，再通过 PATH 中兼容的 `skills >=1.5.23 <2.0.0` 执行 scope-wide 冲突预检、`skills add ... --yes` 和完成后验证。确认后的执行复用单一 `AW_HOME` mutation lock，并重新采集 Catalog、config、物化、版本和冲突证据；外部安装失败或验证缺项不做补偿回滚，receipt 提供重跑或外部 `skills remove` 恢复方式。project scope 在解析的项目根运行，user scope 使用 `--global`。

`aw skill materialize` 在同父目录 staging 中验证所选输出，再替换仅由相同 plugin ID 和 scope 的 schema 1 marker 证明属于 AW 的目标。foreign、身份不匹配、符号链接或过宽目标都 fail closed；命令不提供 force，也不创建 portable installed state。

TUI 在插件预览和详情中只根据 `distributions.agentSkills` 声明显示 Portable 能力，不提前运行 renderer 或声明精确候选数和安装 ownership。用户进入安装流后才物化完整依赖闭包，并依次选择 Skill、Agent 和 scope；Review 只显示实际选择、依赖贡献和冲突。执行复用 `aw skill install` 的锁内证据重采集，证据变化时必须回到 Review 重新确认。

## Catalog Sources and Cache

每个 source 在 `<AW_HOME>/catalog-cache/sources/<sourceId>/{current,last-good}/` 有独立身份、当前快照和最近一次可用快照。resolver 先使用有效的 `current`，需要时可回退同一 source 的 `last-good`。cache 只是可删除的性能和离线状态；它不决定安装、配置或删除权限。

`aw catalog source add` 和 `update` 先原子提交 source config，再尽力刷新该 source。刷新成功时 receipt 附带来源证据；刷新失败时 config 仍已提交，receipt 报告该 source 的诊断。其它来源不会因此失败。`list`、`set-primary` 和 `remove` 只修改 source config。

多来源 resolver 在稳定的 cache generation 内调用消费者回调。回调只能返回普通数据，不能保留 bundle root、manifest path 或其它缓存路径。generation 结束后，调用方必须重新解析，不得保存内部路径。

## Write Pipeline

五个公开写命令使用同一条 rebuild 流程：

```text
解析当前 Catalog 和目标
  → 生成临时依赖顺序与期望组件
  → 检查 live ownership
  → 必要时清理 AW-owned 旧组件
  → 写入原生和 AW-managed 组件
  → 按命令运行 lifecycle
  → 完成后检查
  → 输出 receipt v4
```

依赖执行顺序只在本次命令内存在。receipt 可摘要公开 requested/resolved plugin ID、dependency edge、relation、requiredBy 和 dependency state；它不公开持久计划、摘要、锁或来源内部证据。

- `install`：按当前 Catalog 安装请求插件和缺失依赖；已存在且完整的依赖使用 `keep`，不重复安装。
- `upgrade`：按当前 Catalog 重建选择的目标和完整依赖闭包；`--all` 从 live owner 发现目标。依赖按稳定的依赖优先顺序重建。
- `reinstall`：先只清理 AW-owned 组件，再按当前 Catalog 完整重建。
- `uninstall`：删除 AW-owned 组件；可用时从 lifecycle active snapshot 重放历史 uninstall lifecycle。source 不可用且无法安全重放时，命令失败并提示 `cleanup`。
- `cleanup`：不运行 uninstall lifecycle。它可在 source 或 Catalog 不可用时，根据 live AW owner 现场清理。它保留 plugin config。
- `cleanup --force`：用于跳过依赖保护，或恢复专属且已损坏的 AW-owned 输出。它可能让 dependent 变为 partial；它不得删除 foreign 或 shared 内容，且保留配置。

每条失败链必须可用 `cleanup`、`cleanup --force`、`reinstall`、来源刷新或新版本发布恢复。无法证明 ownership 时宁可保留内容，也不能删除用户或共享内容。

### Lifecycle Active State

`lifecycle-active/` 保存最近一次成功写入后、下一次 uninstall 所需的 bundle 和输入。它只服务 lifecycle replay，不决定插件存在，也不参与 status 健康判断。snapshot 缺失或损坏不会把 live owner 变成 absent；`cleanup` 仍可清理可证明属于 AW 的输出。

安装或升级的 lifecycle 写入失败时，AW 清理本次已拥有组件并保留可恢复的现场。达到持久平台写入点后的失败可以留下 partial 状态；用户使用 status 和 reinstall 或 cleanup 恢复。

## Live Status and Config

`aw status` 是只读操作。它组合多来源 Catalog、live owner、原生平台组件和有效配置，并对每个来源独立报告错误。它不运行 lifecycle，也不创建 config 目录。`cacheFirst` 先读有效 cache；cache miss 时 Git source 可以访问远端并更新弱 cache，path source 每次物化路径内容并更新弱 cache。

每个 target 的状态为：

| 状态 | 含义 | 建议 |
|---|---|---|
| `present` | 所有期望 AW-owned 组件存在 | 无 |
| `absent` | 没有发现该 target 的 AW-owned 组件 | `aw install` |
| `partial` | 只有部分组件或组件不完整 | `aw reinstall` |
| `error` | Catalog、发现或组件检查失败 | 修复来源或现场后重试 |

`status --json` 保持 schema 4。公开状态只描述当前组件和安全诊断；它不输出内部 cache 路径、生命周期内容或依赖执行细节。

配置按 manifest default、user、project shared、project local 合并。source config 和 plugin config 均使用原子替换。config 已提交后，后续平台重新安装失败不回滚该配置；receipt 和 status 报告 partial 结果，用户可重新安装恢复。

## Platform Boundaries

- 只删除可证明属于 AW 的 marker、managed block、artifact 或 namespaced 组件。
- 外部 Codex/Claude 命令、用户手改目录和共享 marketplace 都是不受 AW 完全控制的边界。命令允许部分成功，并报告残留和失败。
- active marketplace、backup、quarantine 和 lifecycle snapshot 都是弱状态。清理失败时保留它们，后续 cleanup 可重试；不得因为弱状态损坏永久阻止用户清理自己的 AW 输出。
- 项目范围路径必须在项目边界内；不跟随不安全的符号链接或删除 foreign 内容。

## Release Flow

根级正常发布入口只有 `release:status`、`release:target`、`release:prepare` 和 `release:publish`。不提供其它正常发布命令，也不要求额外提交生成状态。

- `release:status [-- --json]` 读取当前 target 和远端版本，显示 beta 与 stable 候选。
- `release:target` 接受一个或多个 `--cli major|minor|patch`、`--catalog major|minor|patch`、`--plugin <name>=major|minor|patch`，并原子更新相应 source target。
- `release:prepare -- beta|stable` 从干净 source HEAD 构建本地 artifacts，写入 `.release/prepared/descriptor.json`。
- `release:publish` 不接受版本参数。它只读取并验证本地 prepared artifacts，然后按 `Eval → CLI → Catalog` 的固定顺序发布已启用的轴。

`.release/prepared/` 在 gitignore 下，是可删除的弱状态；删除后重新 prepare。`attempted.json` 是 gitignored 的本地安全门禁，不得手动删除。任何远端尝试前写入该 marker；远端失败或结果不确定后，必须 bump 相关 target。工具在 target digest 改变后处理旧 marker，再 prepare 和 publish 新版本；不得重跑同一候选。

Catalog publisher 使用 prepared snapshot 写入相应 channel 和版本 tag。远端原子写失败或结果不确定时，同样必须提升 Catalog 版本后重发。

## Key Paths

- `packages/cli/scripts/bundle-plugins.ts`：生成 catalog snapshot。
- `packages/cli/scripts/plugin-staging.ts`：生成 Catalog staging 内容。
- `scripts/release/prepared-release.mjs`：生成、验证和消费本地 prepared release。
- `scripts/release/git-catalog-publisher.mjs`：发布 prepared Catalog snapshot。
- `packages/cli/authoring/`：随 CLI 发布的确定性插件作者实现。
