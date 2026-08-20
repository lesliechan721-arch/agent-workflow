---
name: author-aw-plugin
description: >-
  当用户要创建或维护一个 AW 插件根、Skill、extension、MCP/App、slash command、dynamic artifact、稳定版本或构建验证时使用。目标根由 `.agents-plugin/plugin.json` 标识，可以位于任意兼容工作区；拥有插件源码写入和作者验证，不做独立质量评分或发布裁决。
compatibility: Requires Node.js 22+, target workspace dependencies, agent-content-toolkit >= 0.5.0, agent-skill-toolkit >= 0.7.0. Real model Eval additionally needs agent-skill-eval-runner >= 0.3.0 or another compatible runner.
user-invocable: true
metadata:
  short-description: 创建或维护 AW 插件并组合通用 Skill 作者能力
---

# Author AW Plugin

本 Skill 只负责 AW manifest、源码、README、构建、版本和 materialization；通用 Skill/Eval 标准由下层 toolkit 提供。

## 依赖 Gate

需要时检查 `author-agent-skill`、`design-agent-skill-evals`、`audit-agent-skill-evals`。真实模型 Eval 还需要显式 runner。缺失通用能力时停止，不复制简化标准；缺少 runner 时只交付结构和 Oracle 证据。

## 工作流

1. 明确 `<plugin-root>` 与 `<workspace-root>`，读取 manifest、现有源码、工作区规则和允许修改文件；把本次全部组件请求写成 JSON 数组，再运行 `node scripts/prepare-aw-authoring-context.mjs <plugin-root> --repo-root <workspace-root> --components <json-file> [options]`。每个组件声明唯一 `id`、`type`、`operation`、`paths` 和 `profiles`；Skill 还必须声明 `skillInvocation`。
2. 按变更面读取 reference：

| 变更面 | reference |
| --- | --- |
| manifest 字段、路径、版本或兼容性 | `references/plugin-manifest-spec.md` |
| Skill | `references/aw-skill-integration.md`；客户端字段直接读 `references/skill-frontmatter-capabilities.generated.md` |
| Extension/hooks/permissions/agents | `references/extensions-spec.md` |
| Slash command | `references/slash-commands.md` |
| MCP/App | `references/mcp-and-apps.md` |
| Claude-only | `references/claude-only-capabilities.md` |
| Node/build | `references/build-config-spec.md` 与 `references/aw-script-testing.md` |
| config/helper | `references/aw-config-and-helper.md` |
| dynamic artifact | `references/aw-artifact-renderer.md` |
| lifecycle | `references/aw-lifecycle.md` |
| 用户可观察变化 | `references/aw-readme-authoring.md` |

按 `components[]` 中的全部类型读取需要的 branch；同一复合请求可以读取多个 branch，但不读取无关 reference。

3. 新建或重大变更 Skill：fresh context 运行 `author-agent-skill`。需要 Eval：fresh context 运行 `design-agent-skill-evals`，再用另一个 fresh context 运行 `audit-agent-skill-evals(preflight)`。AW adapter 拥有组合流程，`evalStageOwner=caller`。
4. 写入插件 source truth；不手改 generated runtime、catalog 或 cache。README 由本 Skill 按 `aw-readme-authoring.md` 维护。
5. production bundle 变化时提高 manifest 稳定版本；从目标工作区发现 build、test、materialization 和 release 命令，运行声明的 validator 和直接测试。
6. Eval preflight 通过且用户授权、runner 可用时，生成 `EvalExecutionPlan` 交给 `run-agent-skill-evals`；运行后由独立 `audit-agent-skill-evals(result-triage)` 归因。缺少 runner 时 `evalEvidenceLevel=structural`，不实现备用 runner。
7. 交付源码修改、version、验证、materialized artifacts、Eval audit/evidence 和未完成项；不输出独立 Review score、P0/P1 或 release pass。
