# Architecture

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

## Three-Layer Distribution Model

```text
Source layer
  plugins/marketplace-source.json
  plugins/<name>/.agents-plugin/plugin.json
  plugins/<name>/skills/**
  plugins/<name>/skills/<skill>/evals/**          [author-only]
  plugins/<name>/templates/<skill>/evals/**       [author-only]
  <skill-root>/reports/**                         [author-only]

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
- Skill 根的 `evals/**` 和 `reports/**` 不进入 catalog runtime bundle、安装制品或 runtime digest。eval 工作目录固定在仓库 `.tmp/agent-workflows/evals/`，持久报告留在 owner Skill。
- catalog staging 是生成物，不手工修改。
- `@lesliechan721/aw-plugins-manifest` 是 sidecar；`@lesliechan721/aw-plugins` 是同版本 full catalog。
- CLI version、catalog version 和 plugin version 是三套独立身份。
- catalog manifest 使用 schema 2，只描述 current 单版本快照。它记录 catalog 最低 CLI 版本、sidecar/full package identity，以及每个 current plugin 的版本、最低 CLI 版本、`artifactDigest` 和 `manifestDigest`。
- 发布门禁要求目标 channel 的 catalog version 单调不降低。同一 catalog version 的 sidecar/full 包已存在时，待发布 package 必须与 registry 中的 exact-version package 字节相同。
- strict catalog cache 按 selector、registry source identity、integrity、manifest digest 和 CLI compatibility 隔离。并发写入使用 immutable entry、原子 selector publication 和有界 lock。
- active marketplace 只供平台原生能力读取。`AW_HOME` 同盘 sibling coordination root 提供 lifecycle lease 和 runtime lease；同时需要两者时，固定按 lifecycle、runtime 的顺序获取。runtime lease 串行根替换、user config 及 Codex user Skill overlay 的写入，lifecycle lease 保护 active snapshot。只读检查不获取排他租约，也不创建 coordination 状态。operation lock 也位于 sibling root，不进入被替换目录。重建必须保留 strict catalog cache、AW config store、Codex user Skill overlay 和 lifecycle active snapshot。

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

## Platform Boundaries

- Claude user/project 目标使用 Claude 原生目录、settings、skills 和 hooks 能力。
- Codex user 目标可使用 `codex plugin marketplace add/list/remove` 和 `codex plugin add/remove`。
- Codex project 目标只写当前仓库的 `.agents/skills/`、`.codex/config.toml`、`.codex/hooks.json`、`.codex/rules/` 和 `.codex/agents/`。
- Codex project 写入前要求 Codex `>= 0.145.0`；Claude 写入要求 Claude Code `>= 2.1.88`。
- MCP、apps、hooks、permissions、roles、instructions、skills 和 slash commands 仍是平台能力，不属于状态存储层。

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
- active marketplace 重建失败时，原 strict cache 保持可读。

按 `latest` 或 `beta` channel 选择的 current catalog，其 `compatibility.aw.minVersion` 高于当前 CLI 时，resolver 直接返回 `awVersionTooLow`。显式选择 exact catalog version 且版本不兼容时返回 `explicitCatalogIncompatible`。两种情况都不选择更早的 catalog version。

## Output Contract

- 五个写命令的 JSON receipt 使用 `receiptSchemaVersion: 3`。
- status JSON 使用 `schemaVersion: 3`。
- config read 使用 `configSchemaVersion: 3`；config write 使用 `receiptSchemaVersion: 3`。
- `--json` 成功时 stdout 只包含一个 JSON 对象。
- 错误说明和 verbose/debug 文本写 stderr，不污染 JSON stdout。
- 写命令失败时 receipt 保留失败 target，并返回非零退出码。

## Key Paths

- `packages/cli/scripts/bundle-plugins.ts`：生成 catalog staging。
- `packages/cli/scripts/plugin-staging.ts`：生成 sidecar/full catalog 输入。
- `packages/cli/tests/unit/local-marketplace.test.ts`：strict cache、lock 和 publication 回归。
- `packages/cli/tests/perf/performance-budget.test.ts`：cache、marketplace、live status/console 和 remote deadline 预算。
- `.agents/skills/create-agent-workflows-plugin/`：插件作者工具与参考合同。
- `docs/plugin-installation.md`：CLI 使用与状态说明。
- `docs/testing.md`：测试分层和门禁。
