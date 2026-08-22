---
name: author-aw-plugin
description: >-
  当用户要创建或维护一个 AW 插件根、Skill、extension、MCP/App、slash command、dynamic artifact、稳定版本或构建验证时使用。目标根由 `.agents-plugin/plugin.json` 标识；负责插件源码写入、构建和作者验证，不做独立质量评分或发布裁决。
compatibility: 需要 Node.js 22+、提供所需 aw plugin 作者命令的已安装 aw CLI、目标工作区依赖、agent-content-toolkit >= 0.1.0 和 agent-skill-toolkit >= 0.1.0。
user-invocable: true
metadata:
  short-description: 创建或维护 AW 插件并组合通用作者能力
---

# Author AW Plugin

## 依赖

- `author-agent-skill`：编写或修改插件内 Skill。
- `design-agent-skill-evals`：创建或修改 Eval。
- `audit-agent-skill-evals`：审核 Eval Oracle 与运行结果。

## 工作流

1. 明确 `<plugin-root>` 与 `<workspace-root>`，读取 manifest、源码、工作区规则和允许修改文件，选择作者路径：
   - **轻量 delta**：单个已知组件和少量路径，不改变 manifest capability、profile、invocation、权限、build/materialization、lifecycle、脚本/schema 或 Eval。
   - **结构化路径**：新建插件、增加/删除组件、多组件请求，或改变上述边界。把组件写成 JSON 数组，再运行 `node scripts/prepare-aw-authoring-context.mjs <plugin-root> --repo-root <workspace-root> --components <json-file> [options]`。
2. 只读取实际变更面需要的 reference。
3. 调用作者命令前运行 `aw --version` 和对应 `aw plugin <command> --help`；只使用 help 公开的 flags。
4. 新建或重大变更 Skill 时，启动独立上下文子代理使用 `author-agent-skill` 的完整设计路径；轻量 delta 只传意图、允许路径和验收证据。
5. 需要 Eval 时，启动独立上下文子代理使用 `design-agent-skill-evals` 设计，再启动另一个独立上下文子代理，使用 `audit-agent-skill-evals` 的 `preflight` 模式审核。只有审核通过且 digest 匹配时，才能把计划交给兼容 Eval runner；运行后再用独立上下文子代理执行 `result-triage`。
6. 写入插件 source truth，不手改 generated runtime、catalog 或 cache。
7. 运行 `aw plugin validate <plugin-root>`、适用的 `aw plugin status` 和直接测试。
8. 交付源码修改、作者路径、验证、materialized artifacts、Eval 证据和未完成项；不输出独立 Review score、P0/P1 或 release pass。

## Reference 路由

| 变更面 | reference |
| --- | --- |
| manifest、版本或兼容性 | `references/plugin-manifest-spec.md` |
| Skill | `references/aw-skill-integration.md` 与 `references/skill-frontmatter-capabilities.generated.md` |
| Extension/hooks/permissions/agents | `references/extensions-spec.md` |
| Slash command | `references/slash-commands.md` |
| MCP/App | `references/mcp-and-apps.md` |
| Claude-only | `references/claude-only-capabilities.md` |
| Node/build | `references/build-config-spec.md` 与 `references/aw-script-testing.md` |
| config/helper | `references/aw-config-and-helper.md` |
| dynamic artifact | `references/aw-artifact-renderer.md` |
| lifecycle | `references/aw-lifecycle.md` |
| 用户可观察变化 | `references/aw-readme-authoring.md` |
