---
name: author-aw-plugin
description: >-
  当用户要在任意 Workspace v1 创建或维护 AW 插件根、Skill、extension、MCP/App、slash command、dynamic artifact、版本或构建验证时使用。负责通过已安装 aw CLI 写入插件源码、构建和确定性作者验证；不作为 SDK 或规范真值，也不做独立 Review、Eval Audit、昂贵 Eval 执行或发布裁决。
compatibility: 需要 Node.js 22+、提供所需公开作者命令的已安装 aw CLI、目标工作区依赖、agent-content-toolkit 和 agent-skill-toolkit。
user-invocable: true
metadata:
  short-description: 创建或维护 AW 插件并组合通用作者能力
---

# Author AW Plugin

AW CLI/Core 是机器规范。本 Skill 是 Agent-facing Developer Assistant：只编排当前已安装 CLI 的公开命令，不要求 clone `agent-workflows`，不读取或替代其 `packages/cli`、`node_modules`、生成目录或官方 release 脚本。

## 依赖

- `author-agent-skill`：编写或修改插件内 Skill。
- `design-agent-skill-evals`：仅在用户明确要求创建或修改 Eval 资产时使用。

## 工作流

1. 明确 `<workspace-root>`、`<plugin-root>`、允许修改文件和用户授权。读取现有 manifest、源码和工作区规则。没有 Workspace v1 时，先运行 `aw --version`、`aw catalog init --help`，再使用 `aw catalog init --workspace-root <workspace-root>` 创建它。已有 workspace 不重新初始化。
2. 新建插件、多组件请求、组件增删或 manifest capability 变化时，先读 `references/aw-authoring-profile.md`。把完整 `components[]` 写入临时 JSON，再从本 Skill 根运行 `node scripts/prepare-aw-authoring-context.mjs <plugin-root> --workspace-root <workspace-root> --components <json-file>`；stdout 是 `AWAuthoringContext` v3，输出形状见 `assets/aw-authoring-context.json`。把 stdout 保存到临时文件后，从同一目录运行 `node scripts/validate-json-contract.mjs assets/aw-authoring-context.schema.json <context-json>`。只把验证通过的 context 交给后续作者分支，不写入插件源码。单一已有 Skill 正文的轻量 delta 跳过该工具。
3. 调用每个作者命令前运行 `aw --version` 和对应帮助：`aw plugin init --help`、`aw plugin add-skill --help`、`aw plugin validate --help`、`aw plugin test --help`、`aw plugin build --help`、`aw plugin status --help`、`aw catalog build --help` 或 `aw catalog validate --help`。只使用帮助公开的参数。使用 `aw plugin init <plugin-name> --workspace-root <workspace-root>`、`aw plugin add-skill <plugin-name> --workspace-root <workspace-root>`、`aw plugin validate <plugin-root> --workspace-root <workspace-root>`、`aw plugin test <plugin-root> --workspace-root <workspace-root>` 和 `aw plugin status <plugin-name> --workspace-root <workspace-root>`；不得回退到本 Skill 的本地工具副本。
4. 只读取实际变更面对应的 reference。新建或重大变更 Skill 时使用 `author-agent-skill`；轻量 delta 只传意图、允许路径和验收证据。
5. 用户明确要求创建或修改 Eval 资产时使用 `design-agent-skill-evals`。本 Skill不自动审核或运行 Eval。
6. 写入插件 source truth，不手改 generated runtime、Catalog snapshot、digest、marketplace 或 cache。
7. 先运行 `aw plugin validate <plugin-root> --workspace-root <workspace-root>` 和 `aw plugin test <plugin-root> --workspace-root <workspace-root>`。需要一个插件 bundle 时运行 `aw plugin build <plugin-root> --workspace-root <workspace-root>`；需要完整 snapshot 时运行 `aw catalog build --workspace-root <workspace-root>`，再用 `aw catalog validate <workspace-root>/.aw/catalog` 验证。`status` 只有用户要求 Git 基线比较时才传明确的 `--base <git-ref>`。
8. 验证、版本、materialization、真实 Eval 或 release 相关请求直接读取 `references/aw-validation-and-version.md`，并只使用目标工作区当前公开的 AW CLI 能力。
9. 只有用户已明确要求且授权发布时，才读取 `aw catalog publish --help` 并使用 `aw catalog publish --workspace-root <workspace-root> ...`。绝不自动 publish。
10. 交付源码修改、作者路径、确定性验证、materialized artifacts 和未完成项；完成条件不包括独立 Review 或模型 Eval。

## Reference 路由

| 变更面 | reference |
| --- | --- |
| 新建插件、多组件、组件增删、manifest capability | `references/aw-authoring-profile.md` |
| manifest、版本或兼容性 | `references/plugin-manifest-spec.md` |
| 验证、版本、materialization、Eval 或 release | `references/aw-validation-and-version.md` |
| Skill | `references/aw-skill-integration.md` 与 `references/skill-frontmatter-capabilities.md` |
| Extension/hooks/permissions/agents | `references/extensions-spec.md` |
| Slash command | `references/slash-commands.md` |
| MCP/App | `references/mcp-and-apps.md` |
| Claude-only | `references/claude-only-capabilities.md` |
| Node/build | `references/build-config-spec.md` 与 `references/aw-script-testing.md` |
| config/helper | `references/aw-config-and-helper.md` |
| dynamic artifact | `references/aw-artifact-renderer.md` |
| lifecycle | `references/aw-lifecycle.md` |
| 用户可观察变化 | `references/aw-readme-authoring.md` |
