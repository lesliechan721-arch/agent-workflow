---
name: author-aw-plugin
description: >-
  当用户要在既有合法 AW Catalog Workspace 中创建或维护一个 Plugin Source 的 manifest、Skill、extension、MCP/App、slash command、config、lifecycle、dynamic artifact、插件版本或单插件验证时使用。只负责该插件内部源码；不初始化、维护、构建、验证或发布 Catalog。
compatibility: 需要 Node.js 22+、提供所需公开作者命令的已安装 aw CLI、目标工作区依赖、agent-content-toolkit 和 agent-skill-toolkit。
user-invocable: true
metadata:
  short-description: 创建或维护 AW 插件并组合通用作者能力
---

# Author AW Plugin

AW CLI/Core 是机器规范。本 Skill 是单 Plugin Source 的 Agent-facing Developer Assistant：只编排当前已安装 CLI 的公开 plugin 命令，不要求 clone `agent-workflows`，不读取或替代其 `packages/cli`、`node_modules`、生成目录或官方 release 脚本。

## 依赖

- `author-agent-skill`：编写或修改插件内 Skill。
- `design-agent-skill-evals`：仅在用户明确要求创建或修改 Eval 资产时使用。

## 工作流

1. 明确 `<workspace-root>`、canonical `<plugin-root>`（固定为 `<workspace-root>/plugins/<plugin-name>`）、允许修改文件和用户授权。读取现有 manifest、源码和工作区规则。先确认 `.aw-workspace.json` 和 `plugins/marketplace-source.json` 构成合法 Catalog Workspace。缺少或不合法时停止，不创建 Workspace，并明确要求调用 `author-aw-catalog`。
2. 新建插件、多组件请求、组件增删或 manifest capability 变化时，先读 `references/aw-authoring-profile.md`。把完整 `components[]` 写入临时 JSON。新建时不要预建空插件目录；从本 Skill 根运行 `node scripts/prepare-aw-authoring-context.mjs <workspace-root>/plugins/<name> --mode create --plugin <name> --workspace-root <workspace-root> --components <json-file>`，验证 context 后运行 `aw plugin init <name> --workspace-root <workspace-root>`。修改已有插件时运行同一 context 工具并传 `--mode edit`，不传 `--plugin`。stdout 是 `AWAuthoringContext` v3，输出形状见 `assets/aw-authoring-context.json`。把 stdout 保存到临时文件后，从同一目录运行 `node scripts/validate-json-contract.mjs assets/aw-authoring-context.schema.json <context-json>`。只把验证通过的 context 交给后续作者分支，不写入插件源码。单一已有 Skill 正文的轻量 delta 跳过该工具。
3. 调用每个作者命令前运行 `aw --version` 和对应 `--help`。只使用帮助公开的参数。公开插件入口是 `aw plugin init <name> --workspace-root <workspace-root>`、`aw plugin add-skill <name> --workspace-root <workspace-root>`、`aw plugin validate <plugin-root> --workspace-root <workspace-root>`、`aw plugin test <plugin-root> --workspace-root <workspace-root>`、`aw plugin build <plugin-root> --workspace-root <workspace-root>` 和 `aw plugin status <name> --workspace-root <workspace-root>`。机械字段问题运行 `aw plugin capabilities --surface <surface> --json`；只读取 stdout 的单一 JSON 对象，不缓存或复制其字段表。可用 surface 是 `manifest`、`build-config`、`extensions`、`slash-commands`、`mcp-apps`、`config`、`lifecycle` 和 `artifacts`。不得回退到本 Skill 的本地 registry 或工具副本。
4. 只读取实际变更面对应的 reference。创建或修改插件内 Skill 时委托 `author-agent-skill`，传递意图、允许路径和验收证据；返回后运行 `aw skill validate <skill-root>`。插件级修改继续由本 Skill 持有。
5. 用户明确要求创建或修改 Eval 资产时使用 `design-agent-skill-evals`。本 Skill不自动审核或运行 Eval。
6. 写入插件 source truth，不手改 generated runtime、Catalog metadata、snapshot、digest、marketplace、ledger、attempt 或 cache。
7. 先运行 `aw plugin validate <plugin-root> --workspace-root <workspace-root>` 和 `aw plugin test <plugin-root> --workspace-root <workspace-root>`。需要一个插件 bundle 时运行 `aw plugin build <plugin-root> --workspace-root <workspace-root>`。`status` 只有用户要求 Git 基线比较时才传明确的 `--base <git-ref>`。
8. 验证、插件版本、materialization 或真实 Eval 相关请求读取 `references/aw-validation.md`，并只使用目标工作区当前公开的 AW CLI 能力。Catalog metadata、inventory、依赖聚合、Catalog version、Catalog build/validate/status 和 publication 交还 `author-aw-catalog` 或 `publish-aw-catalog`。
9. 交付单插件源码修改、作者路径、确定性验证、单插件 materialized artifacts 和未完成项；完成条件不包括独立 Review 或模型 Eval，也不包括 Catalog 聚合或 publish。

## Reference 路由

| 变更面 | reference |
| --- | --- |
| 新建插件、多组件、组件增删、manifest capability | `references/aw-authoring-profile.md` |
| manifest、版本或兼容性 | `references/plugin-manifest-spec.md` |
| Portable static Skill 或 portable-only runtime projection | 查询 `manifest` 与 `build-config` surface；保留 native capability 门禁 |
| 单插件验证、plugin version、materialization 或 Eval | `references/aw-validation.md` |
| Skill | `references/aw-skill-integration.md`；字段由 `author-agent-skill` 与 `aw skill validate` 处理 |
| Extension/hooks/permissions/agents | `references/extensions-spec.md` |
| Slash command | `references/slash-commands.md` |
| MCP/App | `references/mcp-and-apps.md` |
| Claude-only | `references/claude-only-capabilities.md` |
| Node/build | `references/build-config-spec.md` 与 `references/aw-script-testing.md` |
| config/helper | `references/aw-config-and-helper.md` |
| dynamic artifact；含 `agent-skills.skill` 与 `runtimeImports` | `references/aw-artifact-renderer.md`；查询 `artifacts` surface |
| lifecycle | `references/aw-lifecycle.md` |
| 用户可观察变化 | `references/aw-readme-authoring.md` |
