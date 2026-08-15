# Architecture

本文件面向仓库维护者，负责 CLI 系统结构、模块边界和稳定产品合同。TypeScript 实现方式见[编码约定](coding-conventions.md)，测试设计见[测试指南](testing.md)，插件专用工作流见[插件维护指南](plugin-maintenance.md)。

## CLI Source Layout (`packages/cli/src`)

- `commands/write-commands.ts` 是 `install`、`upgrade`、`reinstall`、`uninstall`、`cleanup` 的公开写入口。
- `commands/rebuild-command.ts` 解析 current catalog 和 target，并把五个写命令交给同一条 rebuild 流程。
- `commands/rebuild-operations.ts` 只编排 ownership 检查、清理、平台写入、artifact 写入、lifecycle 和完成后检查。
- `commands/rebuild-integration.ts` 把插件能力转换成平台原生写入和 AW-owned 组件。
- `commands/status.ts` 读取 live ownership 和平台组件，输出 status v3，并为控制台提供同一份数据。
- `utils/ownership.ts` 定义 owner marker、组件检查和安全删除边界。
- `utils/lifecycle-active-store.ts` 保存最后一次成功写入所需的 lifecycle 输入。
- `utils/local-marketplace.ts` 管理本机 active marketplace 和严格 catalog cache。
- `utils/plugin-catalog.ts` 解析 current sidecar/full catalog、selector 和严格 cache fallback。
- `utils/plugin-config.ts` 与 `utils/plugin-config-write.ts` 管理 AW config store 和 config v3 输出。
- `output/command-receipt.ts` 生成五个写命令的 receipt v3。
- `generators/` 生成 instructions、permissions、hooks、agents、skills 和 MCP 等平台能力。
- `types.ts` 保存跨模块公开类型。插件 manifest 不支持顶层 `dependencies`。

写命令和 status 只根据 current catalog、live ownership 和平台组件执行。

### Core Types

- `PluginManifestSource`：插件源码 manifest。
- `PluginMeta`：manifest 加 bundle root 和 manifest path。
- `CatalogResolution`：current catalog identity、selector 和 strict cache 证据。
- `OwnedComponent` 与 `OwnerIdentity`：可检查、可删除的平台组件及其归属。
- `DesiredTarget` 与 `RebuildResult`：rebuild 的目标输入和统一结果。
- `StatusJsonPayload`：status v3 公开结构。
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

          ↓ pnpm build / catalog staging

Catalog staging
  ├── .claude-plugin/marketplace.json
  ├── .agents/plugins/marketplace.json
  └── plugins/<name>/**

          ↓ catalog pack / publish

npm registry
  @lesliechan721/aw
  @lesliechan721/aw-plugins-manifest
  @lesliechan721/aw-plugins

          ↓ aw init / write command

Local runtime
  <AW_HOME>/
  ├── catalog-cache/**
  ├── plugins/**
  ├── plugin-config/**
  └── lifecycle-active/**
```

- 仓库源码层是插件作者维护的输入。
- Skill 根的 `evals/**` 和插件根的正式 `reports/**` 不进入 catalog runtime bundle、安装制品或 runtime digest。Skill `README.md` 是 production source，会随 Skill 发布。
- `.tmp/agent-workflows/evals/**` 只保存本地临时证据，不进入 Git 或 runtime bundle。插件正式报告位于 `plugins/<plugin>/reports/`，repo-local 静态 Skill 正式报告位于 `.agents/reports/`。Eval、评审、发布和登记步骤由 [create-aw-plugin](../.agents/skills/create-aw-plugin/README.md) 与 [skill-review](../.agents/skills/skill-review/README.md) 工作流定义。
- catalog staging 是生成物，不手工修改。
- `@lesliechan721/aw-plugins-manifest` 是 sidecar；`@lesliechan721/aw-plugins` 是同版本 full catalog。
- CLI version、catalog version 和 plugin version 是三套独立身份。
- catalog manifest 使用 schema 2，只描述 current 单版本快照。它记录 catalog 最低 CLI 版本、sidecar/full package identity，以及每个 current plugin 的版本、最低 CLI 版本、`artifactDigest` 和 `manifestDigest`。
- 普通构建生成不可发布的 development receipt，以 `contentDigest` 标识插件内容；release intent 声明下一次稳定版本的 bump 类型。
- Beta 发布在临时 staging 中物化 prerelease plugin version。Stable 发布统一应用 intent 后才更新源码 manifest。
- Sidecar 包包含发布端专用的 `plugin-release-ledger.json`。发布门禁合并 beta/latest 账本，保证同一 `plugin@version` 不会对应不同 digest。运行时 catalog manifest 仍使用 schema 2。
- 发布门禁要求目标 channel 的 catalog version 单调不降低。同一 catalog version 的 sidecar/full 包已存在时，待发布 package 必须与 registry 中的 exact-version package 字节相同。
- strict catalog cache 按 selector、registry source identity、integrity、manifest digest 和 CLI compatibility 隔离。并发写入使用 immutable entry、原子 selector publication 和有界 lock。
- active marketplace 只供平台原生能力读取。`AW_HOME` 同盘 sibling coordination root 提供 lifecycle lease 和 runtime lease；同时需要两者时，固定按 lifecycle、runtime 的顺序获取。runtime lease 串行根替换、user config 及 Codex user Skill overlay 的写入，lifecycle lease 保护 active snapshot。只读检查不获取排他租约，也不创建 coordination 状态。operation lock 也位于 sibling root，不进入被替换目录。重建必须保留 strict catalog cache、AW config store、Codex user Skill overlay 和 lifecycle active snapshot。
- markerless Codex user Skill 只有在文件树与 current catalog 或当前 renderer 的期望树完全一致时，才按 pristine catalog 内容和 absent 状态处理。install/reinstall 可以为它原子写入 owner marker；内容变化、多余文件、符号链接或 foreign marker 仍按 collision 处理。

## Write Pipeline

五个写命令只走 rebuild pipeline：

```text
normalize target
  → resolve current catalog
  → build desired platform components
  → inspect live ownership
  → remove stale AW-owned components when required
  → write native and repo-managed components
  → run lifecycle when the command requires it
  → inspect the completed target
  → emit receipt v3
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

`aw status` 与主控制台读取同一份 live status。输入只有 current catalog、AW owner marker 和平台原生组件检查。

每个 target 的 `state` 只允许：

| 状态 | 含义 |
|------|------|
| `present` | 所有期望 AW-owned 组件都存在 |
| `absent` | 没有发现目标的 AW-owned 组件 |
| `partial` | 只存在部分组件，或组件内容不完整 |
| `error` | catalog、发现或组件检查失败 |

`absent` 建议运行 `aw install`。`partial` 建议运行 `aw reinstall`。`error` 保留错误并继续检查其它 target。

catalog 不可用和 bundle 不可用必须分别报告，不能合并成不可定位的通用状态错误。

status v3 JSON 结构：

```json
{
  "schemaVersion": 3,
  "catalog": {},
  "filters": {},
  "targets": [],
  "errors": []
}
```

status 是只读操作。它不运行 lifecycle 或 renderer，不刷新 marketplace，也不创建 config 目录。

## Config

配置合并顺序是 manifest default、user store、project shared store、project local store。project repo-visible artifact 只使用允许共享的 project shared 配置。

- `aw config list/get --json` 输出 `configSchemaVersion: 3`。
- `aw config set/unset/reset --json` 输出 `receiptSchemaVersion: 3`。
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

- 五个写命令的 JSON receipt 使用 `receiptSchemaVersion: 3`。
- status JSON 使用 `schemaVersion: 3`。
- config read 使用 `configSchemaVersion: 3`；config write 使用 `receiptSchemaVersion: 3`。
- `--json` 成功时 stdout 只包含一个 JSON 对象。
- 错误说明和 verbose/debug 文本写 stderr，不污染 JSON stdout。
- 写命令失败时 receipt 保留失败 target，并返回非零退出码。

### Human/TUI progress

- 裸 `aw` 使用响应式 Ink 仪表盘。宽视口同时显示插件、操作和目标/状态，窄视口使用单栏页面，过小视口只显示尺寸提示。状态信息位于目标详情，写操作位于操作区，配置位于插件配置页。
- 五个写命令和缺少必要参数的 config 命令只在真实 TTY、human 模式且非 CI 时进入轻量向导。完整参数、CI、非 TTY 和 `--json` 不进入向导。
- 向导在挂载前拒绝不可用 catalog 和当前操作的空候选集。file/directory 配置在仪表盘和向导中按私有值投影，命令摘要只显示占位符模板。
- 向导的可重放命令明确标注 shell：POSIX 使用 shell-safe 单引号；Windows 提供 PowerShell 命令和参数列表。
- 向导执行失败后只向 human stderr 输出固定安全错误；原始执行错误只进入遵守脱敏规则的 debug 事件。完整参数的非 TUI 命令保留原有错误合同。
- 运行前取消直接退出。真实写入开始后的 `Ctrl-C` 只登记“完成后退出”，不取消底层写操作。
- rebuild action 边界发出 `rebuild:action` 事件。source 固定包含 plugin、platform、scope 和 command；data 固定包含动作名和 start/success/failure，终态包含 duration。失败消息在进入可见日志前脱敏。
- 仪表盘和命令向导在会话 reporter 中消费 action event 与 notice，不直接写 stdout/stderr。它们显示当前 target、真实中文阶段、elapsed 和最近 8 条消息，内存最多保留 50 条；多 target 更新不能串线。结果页保留最近消息和 human receipt 摘要。无 action event 的读取只显示通用 spinner。
- sensitive config、未脱敏 event message 和 native raw invocation/data 不进入 frame、stdout 或 stderr。
- TUI 结束后必须恢复 session reporter；每个事件只向 debug logger 发送一次。
- `rebuild:action` 只服务 human、TUI、verbose 和 debug 诊断，不进入 v3 JSON receipt。普通 human reporter 忽略 event；verbose 写 stderr；`--json` stdout 仍只包含一个对象。

## Key Paths

- `packages/cli/scripts/bundle-plugins.ts`：生成 catalog staging。
- `packages/cli/scripts/plugin-staging.ts`：生成 sidecar/full catalog 输入。
- `.agents/skills/create-aw-plugin/`：插件作者工作流与参考合同。
