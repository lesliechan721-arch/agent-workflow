---
name: author-aw-plugin
description: >-
  当用户要创建或维护一个 AW 插件根、Skill、extension、MCP/App、slash command、dynamic artifact、版本或构建验证时使用。目标根由 `.agents-plugin/plugin.json` 标识；负责插件源码写入、构建和确定性作者验证，不做独立 Review、Eval Audit、昂贵 Eval 执行或发布裁决。
compatibility: 需要 Node.js 22+、提供所需 aw plugin 作者命令的已安装 aw CLI、目标工作区依赖、agent-content-toolkit 和 agent-skill-toolkit。
user-invocable: true
metadata:
  short-description: 创建或维护 AW 插件并组合通用作者能力
---

# Author AW Plugin

## 依赖

- `author-agent-skill`：编写或修改插件内 Skill。
- `design-agent-skill-evals`：仅在用户明确要求创建或修改 Eval 资产时使用。

## 工作流

1. 明确 `<plugin-root>` 与 `<workspace-root>`，读取 manifest、源码、工作区规则和允许修改文件。
2. 新建插件、多组件请求、组件增删或 manifest capability 变化时，先读 `references/aw-authoring-profile.md`。结构化分支把完整 `components[]` 写入临时 JSON，再从本 Skill 根运行 `node scripts/prepare-aw-authoring-context.mjs <plugin-root> --repo-root <workspace-root> --components <json-file>`；stdout 是 `AWAuthoringContext` v3，输出形状见 `assets/aw-authoring-context.json`。把 stdout 保存到临时文件后，从同一目录运行 `node scripts/validate-json-contract.mjs assets/aw-authoring-context.schema.json <context-json>`；只把验证通过的 context 交给后续作者分支，不写入插件源码。单一已有 Skill 正文的轻量 delta 跳过该工具。
3. 调用作者命令前运行 `aw --version` 和对应帮助：`aw plugin init --help`、`aw plugin add-skill --help`、`aw plugin validate --help` 或 `aw plugin status --help`。只使用帮助公开的参数；分别通过 `aw plugin init <plugin-name>`、`aw plugin add-skill <plugin-name>`、`aw plugin validate <plugin-root>` 和 `aw plugin status <plugin-name>` 执行，不得回退到本 Skill 的本地工具副本。
4. 只读取实际变更面对应的 reference。新建或重大变更 Skill 时使用 `author-agent-skill`；轻量 delta 只传意图、允许路径和验收证据。
5. 用户明确要求创建或修改 Eval 资产时使用 `design-agent-skill-evals`。本 Skill不自动审核或运行 Eval。
6. 写入插件 source truth，不手改 generated runtime、catalog 或 cache。
7. 验证、版本、materialization、真实 Eval 或 release 相关请求直接读取 `references/aw-validation-and-version.md`，并只使用目标工作区当前公开的 AW CLI 能力。
8. 运行 `aw plugin validate <plugin-root>`、适用的 `aw plugin status` 和本次修改直接相关的 build/test。
9. 交付源码修改、作者路径、确定性验证、materialized artifacts 和未完成项；完成条件不包括独立 Review 或模型 Eval。

## Reference 路由

| 变更面 | reference |
| --- | --- |
| 新建插件、多组件、组件增删、manifest capability | `references/aw-authoring-profile.md` |
| manifest、版本或兼容性 | `references/plugin-manifest-spec.md` |
| Portable static Skill 或 portable-only runtime projection | `references/plugin-manifest-capabilities.generated.md` 与 `references/build-config-capabilities.generated.md`；保留 native capability 门禁，且只用 `distributions: ["agent-skills"]` 选择 portable-only projection |
| 验证、版本、materialization、Eval 或 release | `references/aw-validation-and-version.md` |
| Skill | `references/aw-skill-integration.md` 与 `references/skill-frontmatter-capabilities.md` |
| Extension/hooks/permissions/agents | `references/extensions-spec.md` |
| Slash command | `references/slash-commands.md` |
| MCP/App | `references/mcp-and-apps.md` |
| Claude-only | `references/claude-only-capabilities.md` |
| Node/build | `references/build-config-spec.md` 与 `references/aw-script-testing.md` |
| config/helper | `references/aw-config-and-helper.md` |
| dynamic artifact；含 `agent-skills.skill` 与 `runtimeImports` | `references/aw-artifact-renderer.md` 与 `references/config-lifecycle-artifact-capabilities.generated.md`；Portable target 使用 distribution identity，不把它推断成第三个平台 |
| lifecycle | `references/aw-lifecycle.md` |
| 用户可观察变化 | `references/aw-readme-authoring.md` |
