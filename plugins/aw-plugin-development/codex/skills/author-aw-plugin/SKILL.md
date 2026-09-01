---
name: author-aw-plugin
description: >-
  当用户要在既有合法 AW Catalog Workspace 中创建或维护一个 Plugin Source 的 manifest、Skill、extension、MCP/App、slash command、config、lifecycle、dynamic artifact、插件版本或单插件验证时使用。只有 `author-aw-catalog` 已明确交接删除任务时才删除；只负责该插件内部源码，不初始化、维护、构建、验证或发布 Catalog。
compatibility: 需要 Node.js 22+、提供所需公开作者命令的已安装 aw CLI、目标工作区依赖、agent-content-toolkit 和 agent-skill-toolkit。
user-invocable: true
metadata:
  short-description: 创建或维护 AW 插件；只处理 Catalog Author 交接的安全删除
---

# Author AW Plugin

AW CLI/Core 是机器规范。本 Skill 是单 Plugin Source 的 Agent-facing Developer Assistant：只编排当前 PATH 中已安装 CLI 的公开 plugin 命令，不读取或替代私有实现、生成目录或 release 脚本。

## 依赖

- `author-agent-skill`：编写或修改插件内 Skill。
- `design-agent-skill-evals`：仅在用户明确要求创建或修改 Eval 资产时使用。

## 工作流

1. 从平台 Skill locator 或当前加载的 `SKILL.md` 确定本 Skill 的真实 `<skill-root>`，不从 cwd 推断。首次 AW 命令必须是 `aw self check --from <skill-root> --json`。命令不可用时停止并报告 `aw` 缺失；receipt 的 `ok` 为 `false` 时停止并精确报告其 `missingCapabilities`，不使用 `--require`、版本比较或固定 executable。
2. 依次从用户明确的 Workspace root、canonical `<root>/plugins/<name>` target、或上游 handoff 的 resolved root 确定 `<workspace-root>`，并把 `<plugin-root>` 固定为 `<workspace-root>/plugins/<plugin-name>`。所有已知 canonical targets 和 handoff paths 必须与该 root 一致；多个 target 推导出不同 root、root 缺失或定位有歧义时停止并询问。公开 plugin 命令自身支持 `--workspace-root` 和 target 自动发现：已有 root 时把同一 root 传给后续命令；只有任务明确指向 current Workspace 且没有可选 root 时，才允许所需的公开 plugin 命令从 canonical target 或 cwd 自动发现。若 mutation 前必须先取得 current Workspace root，则从 cwd 运行只读 `aw plugin status --all --json`。不得为定位运行 Catalog 命令。Workspace 缺失或非法时停止，保留公开 plugin 命令的错误证据；用户要初始化 Catalog 时路由 `author-aw-catalog`。
3. 明确插件名、允许修改文件和用户授权，读取现有 manifest、源码和工作区规则。删除或移除分支只在 `author-aw-catalog` 已明确交接一个删除任务时进入。在任何 mutation 前，确认 handoff 明确提供 `<plugin-name>`，不从 inventory 猜测目标；没有 handoff 时停止，并要求调用 `author-aw-catalog`。先运行 `aw plugin remove --help`，只使用帮助公开的参数，然后运行 `aw plugin remove <plugin-name> --workspace-root <workspace-root> --yes --json`。不得直接调用 `rm`、递归删除或任何未公开参数；不得提供、猜测或要求 `--force`。不得修改 Catalog metadata、版本、ledger，也不得新增 tombstone 或 retirement metadata，且不得 commit、build 或 publish。成功后只把 CLI 的结构化 receipt 和控制权交回 `author-aw-catalog`；不要继续普通修改完成步骤，尤其不得对已删除插件运行 validate、test、build 或 status。
4. 新建插件、多组件请求、组件增删或 manifest capability 变化时，先读 `references/aw-authoring-profile.md`。把完整 `components[]` 写入临时 JSON。新建时不要预建空插件目录；从本 Skill 根运行 `node scripts/prepare-aw-authoring-context.mjs <workspace-root>/plugins/<name> --mode create --plugin <name> --workspace-root <workspace-root> --components <json-file>`，验证 context 后运行 `aw plugin init <name> --workspace-root <workspace-root>`。修改已有插件时运行同一 context 工具并传 `--mode edit`，不传 `--plugin`。stdout 是 `AWAuthoringContext` v3，输出形状见 `assets/aw-authoring-context.json`。把 stdout 保存到临时文件后，从同一目录运行 `node scripts/validate-json-contract.mjs assets/aw-authoring-context.schema.json <context-json>`。只把验证通过的 context 交给后续作者分支，不写入插件源码。单一已有 Skill 正文的轻量 delta 跳过该工具。
5. 需要字段合同前先运行 `aw plugin capabilities --json`，只读取 receipt `capabilities` 的实际 keys。仅当所需领域在该 receipt 中存在时，才运行 `aw plugin capabilities --surface <surface> --json`；不维护封闭 surface 列表、字段表或本地 registry。调用其它作者命令前按需运行对应 `--help`，并只使用帮助公开的参数。
6. 只读取实际变更面对应的 reference。创建或修改插件内 Skill 时委托 `author-agent-skill`，传递意图、允许路径和验收证据；返回后运行 `aw skill validate <skill-root>`。插件级修改继续由本 Skill 持有。
7. 用户明确要求创建或修改 Eval 资产时使用 `design-agent-skill-evals`。本 Skill不自动审核或运行 Eval。
8. 写入插件 source truth，不手改 generated runtime、Catalog metadata、snapshot、digest、marketplace、ledger、attempt 或 cache。
9. 对非删除分支，先运行 `aw plugin requirements <plugin-root> --workspace-root <workspace-root> --json`，读取 declared、derived、detected、effective 和 observations。只有实际动态 AW 调用无法自动发现时，才用 `--add <capability>` 声明其已知粗粒度 capability；不计算或 pin AW version。随后运行 `aw plugin validate <plugin-root> --workspace-root <workspace-root>`；任务需要时再运行 `aw plugin test` 或 `aw plugin build`。`status` 只有用户要求 Git 基线比较时才传明确的 `--base <git-ref>`。不 build 或 validate Catalog。
10. 验证、插件版本、materialization 或真实 Eval 相关请求读取 `references/aw-validation.md`，并只使用目标工作区当前公开的 AW CLI 能力。Catalog metadata、inventory、依赖聚合、Catalog version、Catalog build/validate/status 和 publication 交还 `author-aw-catalog` 或 `publish-aw-catalog`。
11. 交付单插件源码修改、作者路径、确定性验证、单插件 materialized artifacts 和未完成项；删除分支只交付结构化 receipt。完成条件不包括独立 Review 或模型 Eval，也不包括 Catalog 聚合或 publish。

## Reference 路由

| 变更面 | reference |
| --- | --- |
| 新建插件、多组件、组件增删、manifest capability | `references/aw-authoring-profile.md` |
| manifest、版本或兼容性 | `references/plugin-manifest-spec.md` |
| 删除或移除单个 Plugin Source | `references/aw-validation.md`；只执行公开 remove 命令并把 receipt 交回 Catalog Author |
| Portable static Skill 或 portable-only runtime projection | 从 live capability receipt 选择实际存在的领域；保留 native capability 门禁 |
| 单插件验证、plugin version、materialization 或 Eval | `references/aw-validation.md` |
| Skill | `references/aw-skill-integration.md`；字段由 `author-agent-skill` 与 `aw skill validate` 处理 |
| Extension/hooks/permissions/agents | `references/extensions-spec.md` |
| Slash command | `references/slash-commands.md` |
| MCP/App | `references/mcp-and-apps.md` |
| Claude-only | `references/claude-only-capabilities.md` |
| Node/build | `references/build-config-spec.md` 与 `references/aw-script-testing.md` |
| config/helper | `references/aw-config-and-helper.md` |
| dynamic artifact；含 `agent-skills.skill` 与 `runtimeImports` | `references/aw-artifact-renderer.md`；从 live capability receipt 选择实际存在的领域 |
| lifecycle | `references/aw-lifecycle.md` |
| 用户可观察变化 | `references/aw-readme-authoring.md` |
