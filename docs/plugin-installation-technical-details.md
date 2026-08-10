# 插件安装技术细节：Codex 与 Claude Code

本文说明 current catalog、rebuild、live ownership、lifecycle active、config 和平台输出之间的关系。

## Runtime Model

```text
catalog source
  → sidecar/full identity validation
  → strict catalog cache
  → desired platform components
  → live ownership inspection
  → rebuild write or cleanup
  → completed live inspection
```

运行时不维护独立的安装健康数据库。当前状态来自 current catalog、AW owner marker 和平台原生组件。

## Current Catalog

`@yiliang/aw-plugins-manifest` sidecar 提供 catalog identity、compatibility、entries、digest 和 history。`@yiliang/aw-plugins` full 包提供同版本当前 artifact。

catalog history 保留历史 catalog version、catalog 最低 CLI 版本、plugin version、plugin 最低 CLI 版本、`artifactDigest` 和 `manifestDigest`。latest catalog 与当前 CLI 不兼容时，resolver 只按该 history 查找同轨兼容 catalog。

严格 cache 具有以下边界：

- selector 和 registry source identity 隔离。
- entry immutable，写完后才发布 selector index。
- 较新的 observation 不被较旧完成结果覆盖。
- lock 有 deadline、owner token 和 stale owner 恢复。
- active marketplace 重建失败时，原 cache 保持可读。

## Rebuild Pipeline

五个写命令进入同一条 pipeline：

1. 归一化 plugin、platform、scope 和 cwd。
2. 解析 current catalog 与 plugin bundle。
3. 生成期望的 native、shared config 和 path components。
4. 检查 live ownership。
5. 按命令删除 stale 或全部 AW-owned 组件。
6. 写 native 和 repo-managed 组件。
7. 运行需要的 lifecycle。
8. 再次检查 live ownership。
9. 输出 receipt v3。

命令差异：

| 命令 | 行为 |
|------|------|
| install | 写 current catalog 目标并保存 lifecycle active snapshot |
| upgrade | 按 current catalog 重建目标并更新 active snapshot |
| reinstall | 清理 AW-owned 组件后完整重建；不调用 uninstall lifecycle |
| uninstall | 删除 AW-owned 组件；可使用 active snapshot 运行 uninstall lifecycle |
| cleanup | 只删除能证明属于 AW 的现场组件；不运行 uninstall lifecycle |

所有五个命令保留 config。

## Live Ownership

每个生成组件带 `OwnerIdentity`：

- owner
- plugin
- artifactKey
- platform
- scope

文本文件使用 owner header；Skill 目录使用 owner marker；共享 config 使用可解析的 AW namespace 或 managed block；native plugin 使用平台 identity 和 probe。

检查结果为 `present`、`absent`、`partial` 或 `error`。foreign 内容不能作为 AW-owned 内容删除。

## Lifecycle Active

成功 install/upgrade 会把脚本 bundle、manifest、artifact 列表和必要 context 保存到 `lifecycle-active/`。project target identity 包含项目位置，因此不同项目不会共享一份 snapshot。

uninstall 使用最后一次成功 snapshot。reinstall 的安装阶段可以更新 snapshot，但清理阶段不调用 uninstall lifecycle。cleanup 只处理 ownership，不运行脚本。

snapshot 缺失不改变 live status，也不扩大删除权限。

## Config

路径：

| 层 | 路径 |
|----|------|
| user | `<AW_HOME>/plugin-config/<plugin>/config.json` |
| project shared | `<repo>/.agent-workflows/plugin-config/<plugin>/config.json` |
| project local | `<repo>/.agent-workflows/plugin-config.local/<plugin>/config.json` |

project shared 可提交。project local 默认 ignore。repo-visible artifact 只使用可共享的 project shared 值。

config set/unset 后，AW 对当前可定位 target 运行完整 reinstall。config reset 是删除 store 的唯一入口。

## Claude Targets

Claude user/project target 可以包括：

- plugin installation
- skills
- settings permissions
- hooks
- agents
- rules
- MCP

共享 settings 使用 `awGenerated` namespace 区分 AW 内容和用户内容。删除某个插件时，只移除该插件的 AW namespace。

## Codex User Targets

需要 native plugin 时，AW 使用：

```text
codex plugin marketplace add/list/remove
codex plugin add/list/remove
```

source 是 canonical active marketplace root。写命令使用 post-check 确认平台状态。MCP、hooks、roles、instructions 和 skills 仍按对应平台 helper 写入。

## Codex Project Targets

Codex project scope 不调用用户级 plugin 命令。它只写当前仓库：

- `.agents/skills/`
- `.codex/config.toml`
- `.codex/hooks.json`
- `.codex/rules/`
- `.codex/agents/`

写入前要求 Codex `>= 0.145.0`。通过版本门禁后，不得产生用户级 config/cache side effect。

## Status and Console

status v3 target state：

| state | 含义 |
|-------|------|
| present | 所有期望组件存在 |
| absent | 没有 AW-owned 组件 |
| partial | 部分组件存在或内容不完整 |
| error | catalog、发现或组件检查失败 |

status 不运行 lifecycle/renderer，不刷新 marketplace，不创建 config。console 使用同一份 live status。

## JSON Contracts

- 五写命令：`receiptSchemaVersion: 3`
- status：`schemaVersion: 3`
- config read：`configSchemaVersion: 3`
- config write：`receiptSchemaVersion: 3`

JSON stdout 只包含一个对象。verbose/debug 和错误说明写 stderr。失败 target 保留在 receipt 或 status errors 中，并返回非零退出码。

## Maintenance Boundaries

- manifest/parser 变化：同步作者 validator、reference 和 fixture。
- cache 变化：运行 strict cache unit、perf 和 fetch smoke。
- platform output 变化：运行对应 Codex/Claude unit 与 integration。
- lifecycle 变化：覆盖真实 `AW_PLUGIN_CONTEXT`、active snapshot、artifact 和 timeout。
- 公开 JSON 变化：同步 README、安装指南、架构、测试文档和 CLI JSON harness。
