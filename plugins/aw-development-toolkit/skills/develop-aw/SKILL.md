---
name: develop-aw
description: >-
  当用户要初始化或维护 AW Catalog Workspace、创建或维护 Plugin Source、增删组件、维护 inventory/依赖/版本、构建 materialized 产物或激活本地 development source 时使用。按目标自动路由 Catalog 与 Plugin 分支；不做独立 Review、不运行模型 Eval、不远端发布。
user-invocable: true
compatibility: 需要 Node.js 22+、PATH 中提供公开作者命令的 aw CLI、目标工作区依赖、agent-content-toolkit 和 agent-skill-toolkit。
metadata:
  short-description: 创建、维护和验证 AW Catalog Workspace 与 Plugin Source
---

# Develop AW

本 Skill 只使用当前 PATH 中公开 `aw` 命令，不依赖私有实现作为命令入口，不手改 generated runtime、snapshot、digest、ledger 或 cache。

## 依赖

- Plugin 内 Skill 创建或变更使用 `author-agent-skill`。
- Agent-facing README、prompt、reference 或 role 内容使用 `agent-content`。
- Eval case 设计由 `author-agent-skill` 的 Eval branch 完成；本 Skill 不审核或运行 Eval。

## 入口与 Workspace

1. 从平台提供的 Skill locator 或当前 SKILL.md 所在根取得 `<skill-root>`，不从 cwd 猜测。首次 AW 命令：

   ```bash
   aw self check --from <skill-root> --json
   ```

   命令缺失或 receipt `ok=false` 时停止并报告 `missingCapabilities`；能力要求由 manifest 和 receipt 拥有，不在正文另维护枚举。
2. 根据用户明确 Workspace root、canonical `<root>/plugins/<name>`、上游 handoff 或公开命令安全自动发现固定 `<workspace-root>`。歧义时停止并询问。
3. 判断当前请求属于 Catalog、Plugin、删除、验证/materialization 或 development-source branch；一个请求可按依赖顺序进入多个 branch，但 publication 永远范围外。

## Branch 路由

| 请求 | 读取 |
| --- | --- |
| 初始化/维护 Workspace、metadata、inventory、依赖、Catalog version | `references/catalog-development.md` |
| 创建/维护 Plugin Source、manifest、组件、config、build/runtime artifact | `references/plugin-development.md`；具体组件读 `references/plugin-components.md` |
| 安全删除 Plugin Source | `references/plugin-removal.md` |
| Plugin 内 Skill | `references/plugin-development.md`，并使用 `author-agent-skill` |
| validate/test/build/materialization | `references/plugin-development.md`；Catalog 聚合读 `references/catalog-development.md` |
| 本地 development source | `references/development-source.md` |

字段和参数需要时先调用 `aw <domain> --help` 或 `aw plugin capabilities --json`；不在 Skill 中复制字段表。

## 执行原则

- Catalog branch 拥有 Workspace identity、metadata、inventory、dependency composition、Catalog version 和聚合结果。
- Plugin branch 只拥有单个 Plugin Source 内部内容和单插件验证。
- 删除由当前 Skill 的 Catalog 分支准入并检查反向依赖，再按公开 plugin remove 命令执行；不直接 `rm`。
- 修改 Plugin 内 Skill 时传递目标、允许路径和验收条件给 `author-agent-skill`；返回后由本 Skill 运行 AW-specific validate/build。
- 结构化临时文件只用于 CLI/script 输入；同一上下文的 Skill 调用不创建 AWAuthoringContext 或通用 handoff schema。
- 远端发布不在范围内；需要发布时结束并要求用户显式调用 manual-only `$publish-aw-catalog`。

## 完成

返回实际 source 修改、AW CLI receipts、单插件和 Catalog 聚合验证、materialized 产物、development activation 状态及未完成项。不得输出独立 Review、Eval Audit、模型 Eval 或发布成功。
