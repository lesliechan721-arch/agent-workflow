# Architecture

本文件面向仓库维护者，负责 CLI 系统结构、模块边界和稳定产品合同。TypeScript 实现方式见[编码约定](coding-conventions.md)，测试设计见[测试指南](testing.md)，插件专用工作流见[插件维护指南](plugin-maintenance.md)。

## CLI Source Layout (`packages/cli/src`)

- `commands/write-commands.ts` 是 `install`、`upgrade`、`reinstall`、`uninstall`、`cleanup` 的公开写入口。
- `commands/rebuild-command.ts` 解析 current catalog 和 target，并把五个写命令交给同一条 rebuild 流程。
- `commands/rebuild-operations.ts` 只编排 ownership 检查、清理、平台写入、artifact 写入、lifecycle 和完成后检查。
- `commands/rebuild-integration.ts` 把插件能力转换成平台原生写入和 AW-owned 组件。
- `commands/status-v4.ts` 读取多源 catalog、live ownership 和平台组件，输出 status v4，并为控制台提供同一份数据。
- `utils/ownership.ts` 定义 owner marker、组件检查和安全删除边界。
- `utils/lifecycle-active-store.ts` 保存最后一次成功写入所需的 lifecycle 输入。
- `utils/local-marketplace.ts` 管理本机 active marketplace 和严格 catalog cache。
- `utils/plugin-catalog.ts` 保留旧 npm sidecar/full catalog、selector 和严格 cache fallback 的迁移兼容实现。
- `utils/plugin-config.ts` 与 `utils/plugin-config-write.ts` 管理 namespaced AW config store 和 config v4 输出。
- `output/command-receipt.ts` 生成五个写命令的 receipt v4。
- `generators/` 生成 instructions、permissions、hooks、agents、skills 和 MCP 等平台能力。
- `types.ts` 保存跨模块公开类型。插件 manifest 不支持顶层 `dependencies`。

写命令和 status 只根据 current catalog、live ownership 和平台组件执行。

### Core Types

- `PluginManifestSource`：插件源码 manifest。
- `PluginMeta`：manifest 加 bundle root 和 manifest path。
- `CatalogResolution`：current catalog identity、selector 和 strict cache 证据。
- `OwnedComponent` 与 `OwnerIdentity`：可检查、可删除的平台组件及其归属。
- `DesiredTarget` 与 `RebuildResult`：rebuild 的目标输入和统一结果。
- `StatusV4Payload`：status v4 公开结构。
- `ArtifactPlan`：renderer 和 AW apply 之间的 v2 数据合同。

### Module Invariants

- renderer 只返回 `ArtifactPlan`，不直接写平台文件。
- 写入前必须验证 scope、path boundary、target identity 和最终 Skill tree。
- Codex/Claude Skill 原生调用 metadata 来自最终文件树，AW 只校验和保留。
- command 分支不得新增另一套安装状态投影、依赖图或平台输出记录。

## Three-Layer Distribution Model

```text
Source layer
  plugins/marketplace-source.json
  plugins/<name>/.agents-plugin/plugin.json
  plugins/<name>/README.md
  plugins/<name>/skills/**
  plugins/<name>/skills/<skill>/README.md
  plugins/<name>/skills/<skill>/evals/**          [author-only]
  plugins/<name>/reports/<skill>/<batch-id>/      [formal source history]
    ├── report.md
    └── summary.json

Temporary evaluation layer
  .tmp/agent-workflows/evals/**                   [complete local evidence]

          ↓ pnpm build

Local schema 3 catalog snapshot (`packages/cli/plugins-dist/`)
  ├── catalog-manifest.json
  ├── .claude-plugin/marketplace.json
  ├── .agents/plugins/marketplace.json
  └── plugins/<name>/**

          ↓ make stage-catalog CATALOG_VERSION=<version>

Release staging (`.release/catalog-staging/catalog/`)
  ├── catalog-manifest.json
  ├── plugin-release-ledger.json
  ├── .claude-plugin/marketplace.json
  ├── .agents/plugins/marketplace.json
  └── plugins/<name>/**

          ↓ Git catalog publisher

Git catalog source

          ↓ path/Git source resolution

Local runtime
  <AW_HOME>/
  ├── catalog-sources.json
  ├── catalog-cache/**
  ├── marketplaces/<sourceId>/**
  ├── plugin-config/<sourceId>/<pluginName>/**
  └── lifecycle-active/<sourceId>/**
```

- 仓库源码层是插件作者维护的输入。
- Skill 根的 `evals/**` 和插件根的正式 `reports/**` 不进入 catalog runtime bundle、安装制品或 runtime digest。Skill `README.md` 是 production source，会随 Skill 发布。
- `.tmp/agent-workflows/evals/**` 只保存本地临时证据，不进入 Git 或 runtime bundle。插件正式报告位于 `plugins/<plugin>/reports/`，repo-local 静态 Skill 正式报告位于 `.agents/reports/`。Eval、评审、发布和登记步骤由 [create-aw-plugin](../.agents/skills/create-aw-plugin/README.md) 与 [skill-review](../.agents/skills/skill-review/README.md) 工作流定义。
- 本地 catalog snapshot 和 release staging 都是生成物，不手工修改。
- CLI version、catalog version 和 plugin version 是三套独立身份。
- `pnpm build` 在 `packages/cli/plugins-dist/` 生成 schema 3 snapshot。开发态 `catalogVersion` 使用 CLI package version，channel 由该版本是否为 prerelease 确定，因此 build 不需要发布版本输入。
- schema 3 manifest 保留 `catalogVersion`、`channel`、catalog compatibility 和 current entries，不包含 npm package identity。每个 entry 包含 `artifactDigest`、`manifestDigest` 和基于真实 runtime 内容生成的 `contentDigest`。
- `make stage-catalog CATALOG_VERSION=<version>` 从隔离 build snapshot 生成 `.release/catalog-staging/catalog/`。它使用显式 catalog version，加入 `plugin-release-ledger.json`，完成 snapshot、digest、plugin version 和 ledger 校验后才替换成功产物。
- Git publisher 在隔离临时 repository 中发布。channel 固定为 `refs/heads/catalog/latest` 和 `refs/heads/catalog/beta`；版本 tag 固定为 annotated、immutable 的 `refs/tags/catalog-v<catalogVersion>`。首次 channel commit 是 orphan，后续 commit 只以当前 channel head 为 parent。catalog-only 使用一次 atomic push 同时发布 tag 和 channel；不支持 atomic 的 remote 会安全失败。
- publisher 在 staging 前读取并验证两个 channel 的 schema 3 snapshot 和 ledger，合并完整历史后重新 stage。每个 channel 的 catalog version 严格单调；相同版本只接受相同 runtime 内容。已有 tag 只有在其 peeled snapshot runtime 内容相同时才可作为幂等重试复用，轻量 tag、损坏 snapshot、ledger 缺失和 digest 漂移均 fail closed。
- catalog-only 必须从 npm registry 明确解析当前已发布的同 channel CLI，并通过 catalog compatibility 后才发布。组合发布在写入任何 catalog ref 或发布 CLI 前比较 registry dist-tag 与本地 CLI candidate；相同字符串跳过 CLI 发布，只有 precedence 严格更高的 candidate 才可发布，回退或同 precedence 不同字符串均 fail closed。当前 CLI 已兼容时执行 atomic catalog 后发布 CLI；需要本次 CLI 时执行 immutable tag、CLI npm publish、channel promotion。promotion 只允许 verified tag 的 fast-forward，并提供固定 `release:promote:catalog:<channel>` 恢复入口。
- official Git refs 的实际迁移和 CLI 默认 source cutover 不属于本阶段；旧 npm catalog 的冻结或迁移也尚未执行。
- Git/path 多 source 的待切换基础合同使用 `<AW_HOME>/catalog-sources.json` schema 1。文件缺失时读取内置 official primary；首次配置 mutation 才物化文件。当前 npm resolver 尚不读取此配置。
- schema 2 npm catalog resolver 和 fixture 只为旧 CLI 迁移兼容保留，不再是 build 或 release 真值；CLI cutover 属于 Phase 4C。
- `aw catalog source add/update/list/set-primary/remove` 管理 schema 1 source config。add/update 先用 `forceRemote` 只验证 candidate 中的目标 source，并只保留 lease-safe 普通证据；随后在 runtime lease 内执行引用预检、expected config digest 复查和原子替换。identity 变化、primary 变化和 remove 在发现 schema 1 owner、旧裸名 config/lifecycle 或旧 marketplace 时返回 `legacyStateUnsupported`，不自动迁移或清理。
- Git/path provider、schema 3 snapshot validator、source strict cache 和四 worker multi-source resolver 已作为独立内核存在。snapshot 根只接受 `catalog-manifest.json`、`.agents/`、`.claude-plugin/`、`plugins/` 和可选的发布端 ledger；validator 从真实 plugin manifest 重建完整 entry 投影。provider 从不可变 Git commit 或每次 path 复制物化已验证 snapshot。
- Git provider 只允许 HTTPS、SSH、file URL 和规范绝对本地路径。它清除 Git 命令/配置注入环境，固定 protocol 与 SSH 命令边界，并在网络访问前拒绝改变 source identity 的 Git URL rewrite；managed bare cache 拒绝非受控 local config、内部 symlink 和 object alternates。Abort 和 remote deadline 必须完成整个子进程树清理后才释放 object lock。
- 新 source strict cache 按 `sourceId`、`sourceIdentity`、requested ref、resolved commit、manifest/snapshot digest 和 CLI compatibility 隔离。selector 只发布完成 entry；Git `requireRemote` 只回退同 source identity 和 ref 的兼容 entry，`forceRemote` 与 path source 不回退。
- source observation order 在磁盘 publication lock 内分配，并通过不可变 observation record 持久绑定 entry。selector 必须与 record、source identity、requested ref 和完整有效 entry 一致；悬空、损坏、超前或 identity 不匹配的 selector 先隔离，再参与 publication。
- multi-source resolver 提供 qualified plugin ID、全局裸名唯一性和 desired artifact key 碰撞预检。resolution 和 PluginMeta 只通过 current-cache lease 范围内的 callback 消费；callback 结果经过 lease-safe 深拷贝投影，protected path evidence 不能逃逸。`catalog source`、`init`、公开 `status`、config 和五个写命令均使用该 callback；owner/config/lifecycle store 使用 source namespace。
- 源码 plugin manifest 直接保存下一次稳定版本；`contentDigest` 排除生成 manifest 的 version 字段，用于识别插件内容。
- Beta 发布根据源码稳定版本、`contentDigest` 和已发布账本，在临时 staging 中物化 prerelease plugin version。Stable 发布直接使用源码 manifest version。
- release staging 包含发布端专用的 `plugin-release-ledger.json`。记录以 catalog channel/version 和 plugin name/version 的完整发布身份保留历史；同一 `plugin@version` 跨历史必须保持 `artifactDigest`、`manifestDigest` 和 `contentDigest` 不变。当前 snapshot 的每个 entry 必须有且只有一个当前 catalog 记录。publisher 从两个已发布 channel 合并 ledger，再生成候选 snapshot。
- 旧 npm strict catalog cache 只服务迁移兼容。新 source strict cache 使用 immutable entry、原子 selector publication 和有界 lock。
- active marketplace 只供平台原生能力读取。`AW_HOME` 同盘 sibling coordination root 提供 lifecycle lease 和 runtime lease；同时需要两者时，固定按 lifecycle、runtime 的顺序获取。runtime lease 串行根替换、catalog source config、user config 及 Codex user Skill overlay 的写入，lifecycle lease 保护 active snapshot。只读检查不获取排他租约，也不创建 coordination 状态。operation lock 也位于 sibling root，不进入被替换目录。重建必须保留 catalog source config、strict catalog cache、AW config store、Codex user Skill overlay 和 lifecycle active snapshot。
- markerless Codex user Skill 只有在文件树与 current catalog 或当前 renderer 的期望树完全一致时，才按 pristine catalog 内容和 absent 状态处理。install/reinstall 可以为它原子写入 owner marker；内容变化、多余文件、符号链接或 foreign marker 仍按 collision 处理。

## Write Pipeline

五个公开写命令只进入 namespaced multi-source resolver 和下列 rebuild pipeline，不进入旧 npm resolver：

```text
normalize target
  → resolve current catalog
  → build desired platform components
  → inspect live ownership
  → remove stale AW-owned components when required
  → write native and repo-managed components
  → run lifecycle when the command requires it
  → inspect the completed target
  → emit receipt v4
```

命令行为：

- `install`：按 current catalog 写入目标。
- `upgrade`：按 current catalog 重建已选择目标；`--all` 从 live owner 发现目标。
- `reinstall`：清理 AW-owned 组件，再按 current catalog 完整重建。
- `uninstall`：删除 AW-owned 组件，并在可用时使用 lifecycle active snapshot 运行 uninstall lifecycle。
- `cleanup`：只删除能证明属于 AW 的现场组件，不运行 uninstall lifecycle。

所有写命令都保留 AW config。只有 `aw config reset` 删除 config store。

### Lifecycle active store

`lifecycle-active/` 是唯一的生命周期例外状态。成功 install 或 upgrade 后，AW 保存下一次 uninstall 所需的脚本输入和 bundle 内容。它有以下边界：

- 它只服务 lifecycle 重放。
- 它不决定插件是否存在。
- 它不参与 status 健康判断。
- `reinstall` 的 cleanup 不运行旧 snapshot；重建使用 current bundle 运行 install lifecycle。
- `cleanup` 不运行 uninstall lifecycle。
- lifecycle active snapshot 缺失时，live ownership 仍是写入和清理真值。

## Live Status

`aw status` 使用 multi-source `cacheFirst` 读取，并对每个 source 独立报告错误。它根据 schema 2 live owner 和真实平台组件报告 target；发现 schema 1 owner 时报告 `legacyStateUnsupported`，不迁移或删除。

每个 target 的 `state` 只允许：

| 状态 | 含义 |
|------|------|
| `present` | 所有期望 AW-owned 组件都存在 |
| `absent` | 没有发现目标的 AW-owned 组件 |
| `partial` | 只存在部分组件，或组件内容不完整 |
| `error` | catalog、发现或组件检查失败 |

`absent` 建议运行 `aw install`。`partial` 建议运行 `aw reinstall`。`error` 保留错误并继续检查其它 target。

catalog 不可用和 bundle 不可用必须分别报告，不能合并成不可定位的通用状态错误。

status v4 JSON 结构：

```json
{
  "schemaVersion": 4,
  "catalog": {
    "primarySourceId": "official",
    "configDigest": "sha256:...",
    "compositeDigest": "sha256:...",
    "sources": []
  },
  "filters": {},
  "targets": [],
  "errors": []
}
```

status 是只读操作。它不运行 lifecycle 或 renderer，不刷新 marketplace，也不创建 config 目录。

## Config

配置合并顺序是 manifest default、user store、project shared store、project local store。project repo-visible artifact 只使用允许共享的 project shared 配置。

- `aw config list/get --json` 输出 `configSchemaVersion: 4`，并为已解析 target 输出 `pluginName`、`pluginId`、`sourceId` 和 `sourceIdentity`。
- `aw config set/unset/reset --json` 输出 `receiptSchemaVersion: 4`。namespaced store 绑定 `sourceId` 和 `sourceIdentity`；read 入口遇到旧裸名 store 返回 `legacyStateUnsupported`。
- 平台 shared config 中可分离的 AW owner 使用可逆 schema 2 token，保留 `sourceId`、`sourceIdentity` 和 qualified `pluginId`。不可分离的同一 native key 在任何写入前返回 `artifactCollision`。
- config 写入只对当前可定位 target 运行完整 reinstall。
- `uninstall`、`cleanup` 和 `reinstall` 不删除 config。
- `config reset` 是删除 config store 的唯一入口。
- sensitive config value 不进入 receipt、stderr 或 debug log。

## Platform Boundaries

- Claude user/project 目标使用 Claude 原生目录、settings、skills 和 hooks 能力。
- Codex user 目标可使用 `codex plugin marketplace add/list/remove` 和 `codex plugin add/remove`。
- Codex project 目标只写当前仓库的 `.agents/skills/`、`.codex/config.toml`、`.codex/hooks.json`、`.codex/rules/` 和 `.codex/agents/`。
- Codex project 写入前要求 Codex `>= 0.145.0`；Claude 写入要求 Claude Code `>= 2.1.88`。
- MCP、apps、hooks、permissions、roles、instructions、skills 和 slash commands 仍是平台能力，不属于状态存储层。
- 公共 slash command 在 Claude 输出为 command，在 Codex 输出为 manual-only Skill。

## Catalog Freshness and Cache

| 入口 | freshness policy | 行为 |
|------|------------------|------|
| `aw status` | `cacheFirst` | 优先使用严格验证的本地 cache |
| 主控制台 | `cacheFirst` | warm load 使用本地 cache |
| `install`、`upgrade`、普通 `init` | `requireRemote` | 远程失败时只允许严格匹配的 cache fallback |
| `init --force` | `forceRemote` | 跳过 cache 快路径；公开命令不接受刷新失败后的 fallback 作为成功 |

cache publication 必须满足：

- entry 写入完成前，reader 不能看到部分内容。
- selector index 只能指向已完成的 immutable entry。
- 较旧的远程观察不能覆盖较新的观察。
- registry source identity 不同的 selector index 互不复用。
- lock 等待有 deadline，释放时必须验证 owner token。
- 冲突 observation 不得污染已经提交的 entry。
- corrupt entry 必须隔离，后续 writer 仍能正常发布。
- cache 缺失或损坏不得阻断 active marketplace 重建。
- active marketplace 重建失败时，原 strict cache 保持可读。

按 `latest` 或 `beta` channel 选择的 current catalog，其 `compatibility.aw.minVersion` 高于当前 CLI 时，resolver 直接返回 `awVersionTooLow`。显式选择 exact catalog version 且版本不兼容时返回 `explicitCatalogIncompatible`。两种情况都不选择更早的 catalog version。

## Output Contract

- 五个写命令、`init` 和 config mutation 的 JSON receipt 使用 `receiptSchemaVersion: 4`。
- status JSON 使用 `schemaVersion: 4`。
- config read 使用 `configSchemaVersion: 4`。
- `--json` 成功时 stdout 只包含一个 JSON 对象。
- 错误说明和 verbose/debug 文本写 stderr，不污染 JSON stdout。
- 写命令失败时 receipt 保留失败 target，并返回非零退出码。

### Human/TUI progress

- 裸 `aw` 使用响应式 Ink 仪表盘。宽视口同时显示插件、操作和目标/状态，窄视口使用单栏页面，过小视口只显示尺寸提示。状态信息位于目标详情，写操作位于操作区，配置位于插件配置页。
- 仪表盘和向导用 multi-source `cacheFirst` 读取；重复插件名显示 qualified `pluginId`。交互写操作使用同一 namespaced runtime，不回退到旧 npm catalog 写路径。
- 缺少必要参数的写命令只在真实 TTY、human 模式且非 CI 时进入向导。
- 向导在挂载前拒绝不可用 catalog 和当前操作的空候选集。file/directory 配置在仪表盘和向导中按私有值投影，命令摘要只显示占位符模板。
- 向导的可重放命令明确标注 shell：POSIX 使用 shell-safe 单引号；Windows 提供 PowerShell 命令和参数列表。
- 向导执行失败后只向 human stderr 输出固定安全错误；原始执行错误只进入遵守脱敏规则的 debug 事件。完整参数的非 TUI 命令保留原有错误合同。
- 运行前取消直接退出。真实写入开始后的 `Ctrl-C` 只登记“完成后退出”，不取消底层写操作。
- rebuild action 边界发出 `rebuild:action` 事件。source 固定包含 plugin、platform、scope 和 command；data 固定包含动作名和 start/success/failure，终态包含 duration。失败消息在进入可见日志前脱敏。
- 仪表盘和命令向导在会话 reporter 中消费 action event 与 notice，不直接写 stdout/stderr。它们显示当前 target、真实中文阶段、elapsed 和最近 8 条消息，内存最多保留 50 条；多 target 更新不能串线。结果页保留最近消息和 human receipt 摘要。无 action event 的读取只显示通用 spinner。
- sensitive config、未脱敏 event message 和 native raw invocation/data 不进入 frame、stdout 或 stderr。
- TUI 结束后必须恢复 session reporter；每个事件只向 debug logger 发送一次。
- `rebuild:action` 只服务 human、TUI、verbose 和 debug 诊断，不进入 v4 JSON receipt。普通 human reporter 忽略 event；verbose 写 stderr；`--json` stdout 仍只包含一个对象。

## Key Paths

- `packages/cli/scripts/bundle-plugins.ts`：生成 catalog staging。
- `packages/cli/scripts/plugin-staging.ts`：生成 schema 3 manifest 和 release ledger。
- `scripts/release/stage-catalog.mjs`：生成 `.release/catalog-staging/catalog/` 发布交接目录。
- `scripts/release/git-catalog-publisher.mjs`：验证 remote 历史并发布 immutable tag 和 channel refs。
- `.agents/skills/create-aw-plugin/`：插件作者工作流与参考合同。
