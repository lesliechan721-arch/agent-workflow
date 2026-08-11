# Testing Guidelines

## Test Layers

| 层 | 命令 | 责任 |
|----|------|------|
| Unit | `pnpm test:unit` | 纯函数、manifest、cache、ownership、receipt、status、config 和 rebuild 编排 |
| Integration | `pnpm test:integration` | CLI 入口、作者工具、五个写命令和平台 adapter 组合 |
| Performance | `pnpm test:perf` | 独立性能预算；不进入普通 unit |
| Performance gate | `pnpm test:perf:gate` | 预算结果和 fast unit wall-time 门禁 |
| Smoke | `pnpm test:smoke:*` | 真实 build、pack、fetch 和插件脚本产物 |
| Plugin test | `pnpm plugin:test <plugin>` | 插件自己的确定性 Node 测试 |
| Plugin eval | `pnpm plugin:eval <plugin>` | 通过中央 app-server driver 显式运行模型 eval；不进入普通 CI |

普通测试使用 synthetic catalog、隔离 home 和 fake native runner。不得调用用户真实 Codex/Claude 配置，也不得修改仓库外状态。

## Build Reuse

`scripts/build/ensure-cli-build.mjs` 只在输入、输出和 package identity 都匹配 generation stamp 时复用 build。并发 build 使用 lock；测试覆盖输入变化、输出变化、symlink、并发 owner 和 snapshot 隔离。

常规 unit/integration 不应隐式执行 package manager。真实依赖安装、build 后 production closure 和 tarball 内容进入 smoke。

## Current State Contracts

### Five write commands

`install`、`upgrade`、`reinstall`、`uninstall`、`cleanup` 必须覆盖同一条 rebuild pipeline：

- target 归一化和平台版本门禁
- current catalog 解析
- live ownership 检查
- stale AW-owned 组件删除
- native 和 repo-managed 写入
- lifecycle active prepare/promote/remove
- 完成后 live ownership 检查
- receipt v3 和退出码

关键行为：

- `cleanup` 不运行 uninstall lifecycle。
- `reinstall` 清理后按 current catalog 完整重建。
- `uninstall`、`cleanup` 和 `reinstall` 保留 config。
- 只有 `config reset` 删除 config store。
- 写命令测试只构造 current catalog、live owner 和平台组件 fixture。

### Live status and console

status 测试只允许 `present`、`absent`、`partial`、`error`。至少覆盖：

- 全部期望 owner 组件存在时为 `present`
- 没有 owner 组件时为 `absent`，建议 install
- 部分组件存在时为 `partial`，建议 reinstall
- 某个检查失败时为 `error`，其它 target 继续返回
- catalog 不可用和 bundle 不可用分开报告
- status 不运行 lifecycle/renderer，不写 marketplace 或 config
- console loader 使用同一份 status v3，不建立第二套状态矩阵

`status --json` 使用 `schemaVersion: 3`。stdout 只包含一个 JSON 对象；verbose/debug 和错误说明写 stderr。

### Config

配置测试覆盖 manifest default、user、project shared 和 project local 合并。project repo-visible artifact 不得受 user、project local 或路径型私有值影响。

- `config list/get --json`：`configSchemaVersion: 3`
- `config set/unset/reset --json`：`receiptSchemaVersion: 3`
- set/unset 后对当前可定位 target 运行完整 reinstall
- reset 是唯一 config store 删除入口
- sensitive value 不进入 receipt、stderr 或 debug log

### Manifest dependencies

source manifest 和 catalog entry 遇到顶层 `dependencies` 必须明确报 `unsupported`。测试不再构造 plugin dependency graph、planner 或删除保护。

## Strict Catalog Cache Regression

`tests/unit/local-marketplace.test.ts` 必须保留底层 cache 测试，不依赖安装状态 fixture。至少覆盖：

- cache entry 按 identity 写入和读取
- selector index 按 registry source identity 隔离
- 较新的 remote observation 不被较旧完成结果覆盖
- 并发 immutable writer 不向 reader 暴露部分 entry
- lock deadline、abort 和 owner token 释放边界
- 冲突 observation 不污染已提交 entry
- corrupt entry 被隔离，后续 writer 能正常发布
- active marketplace 重建保留 strict cache
- cache 缺失或损坏不阻断 marketplace 重建
- marketplace 原子替换失败时，原 cache 仍完整可读

cache 测试只构造 cache、lock、selector 和 marketplace fixture。

## Performance Budgets

性能测试在 `packages/cli/tests/perf/`。每个预算必须输出一条：

```text
AW_PERF_SUMMARY {"name":"..."}
```

当前必须有且只能由对应预算产生以下名称：

- `catalog-cache-first-warm`
- `catalog-cache-first-after-marketplace-rebuild`
- `live-status-console-warm`
- `catalog-remote-deadline`

预算覆盖：

| 名称 | 场景 |
|------|------|
| `catalog-cache-first-warm` | 严格验证后的 disk cache-first P95 |
| `catalog-cache-first-after-marketplace-rebuild` | active marketplace 重建后的第一次 cache read |
| `live-status-console-warm` | live owner fixture 上 status 和 console warm chain P95 |
| `catalog-remote-deadline` | pending remote source 的有界 deadline |

`scripts/perf/run-perf-gate.mjs` 必须解析 summary，并校验名称集合与预期完全一致。没有 summary、缺少名称、重复名称或出现未知名称都必须让门禁失败。

性能预算使用宽松、跨平台的上限。它们用于发现数量级回退，不用于比较微小波动。失败时先确认机器负载，再检查 remote call 次数、重复 catalog 校验、cache publication 和 live component probe 数量。

## Test Isolation

- 使用测试提供的隔离 `AW_HOME`、`AW_CODEX_HOME`、`AW_CLAUDE_HOME` 和 workspace。
- 平台命令使用 fake native runner。
- 需要进程树检查的测试在允许 POSIX/Windows 进程检查的环境运行。
- 测试结束后清理自己的临时目录和 mock。
- 不读取或改写真实 home、全局 native plugin 或真实项目配置。

## Platform Capability Regression

保留以下能力测试：

- Codex/Claude skills 和原生调用 metadata
- MCP server 写入和 ownership
- hooks、permissions、roles、instructions 和 agents
- slash commands 的 Claude command / Codex manual-only skill 输出
- Codex project scope 无 user native side effect
- Codex user native marketplace/plugin invocation
- Claude user/project settings 和 skill 输出
- apps 的支持和 scope 边界

这些能力测试验证平台输出，不建立独立安装健康数据库。

## Plugin Authoring Tests

作者工具测试必须锁住：

- manifest 顶层 `dependencies` 明确 unsupported
- source/platform manifest 的允许字段
- ArtifactPlan v2、artifact target 和 sourceDirs
- lifecycle/config helper/context
- Skill 原生调用 metadata
- bundle staging 和平台裁剪
- eval manifest、trigger corpus 和 materialized Codex artifact

作者 references、示例和 eval prompt 必须使用 live owner/status 术语。

## Plugin Eval

`pnpm plugin:eval` 只提供 Codex 证据。默认 materialize 所有 profile，并运行所有 `requiredForRelease` suite/split。使用 suite/profile/split/case 过滤，或减少 runs 时，结果固定为 incomplete，不能作为发布证据。

真实模型运行使用隔离 runtime home，并固定使用文件凭据存储且关闭 secret keychain storage。provider credential 不进入模型 shell，持久化报告必须脱敏。临时 runtime capsule 在成功、失败和中断后清理。

`trigger` 和 `conversation` suite 支持 `isolation: standard|strict`。conversation driver 在 Default 协作模式启用 `request_user_input`。strict 模式只保留目标 Skill，关闭内置 Skill、插件、Apps、MCP 和建议类表面，并在运行前验证有效配置、目标 Skill 和空 MCP 清单。检查失败时结果必须是 incomplete。真实模型 eval 应从普通 Terminal 运行。

## Pre-commit Checklist

- 改 rebuild/write/status/config → 运行相关 unit、integration 和 build
- 改 strict cache 或 selector → 运行 `local-marketplace.test.ts`、plugin catalog 测试、perf 和 fetch smoke
- 改平台输出 → 运行对应平台 unit/integration
- 改作者合同 → 运行 authoring-tools integration 和必要 plugin materialize
- 改 build/tarball → 运行对应 smoke
- 改公开 JSON → 同步检查 receipt v3、status v3、config v3 文档和 CLI JSON harness
- 最后运行 `git diff --check`
