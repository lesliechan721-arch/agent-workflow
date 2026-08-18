---
name: author-aw-plugin
description: >-
  仅当用户显式要求在 agent-workflows 项目中创建或维护 plugins/<name>/ 插件、Skill、extension、MCP/App、slash command、dynamic artifact、稳定版本或构建验证时使用。拥有项目源码写入和作者验证；不做独立质量评分或发布裁决。
compatibility: >-
  Requires the agent-workflows repository, Node.js 22+, installed workspace dependencies, agent-content-toolkit >= 0.2.0, and agent-skill-toolkit >= 0.1.0.
disable-model-invocation: true
user-invocable: true
metadata:
  short-description: 创建或维护 AW 插件，并组合通用 Skill 作者与 Eval 设计能力
---

# Author AW Plugin

本 Skill 是项目作者适配器。通用 Agent-facing 内容标准由 `agent-content-toolkit` 提供；通用 Agent Skill 与 Eval 标准由 `agent-skill-toolkit` 提供；当前 Skill 只负责 AW 源码、构建、版本和 materialization。

## 依赖 Gate

需要时检查以下通用能力：

- `author-agent-skill`
- `design-agent-skill-evals`
- `audit-agent-skill-evals`
- `write-agent-content`

缺失时停止，不在本 Skill 中复制简化标准。人工安装是当前依赖保证；manifest 不声明 plugin dependency。

## 工作流

1. **确认目标和变更面**
   - 读取 `.agents-plugin/plugin.json`、现有源码、项目规则和允许修改文件。
   - 区分新插件、已有插件变更和单一组件变更。
   - 运行 `node scripts/prepare-aw-authoring-context.mjs <plugin-root> --repo-root <repo-root> [options]`，并按 `assets/aw-authoring-context.schema.json` 校验输出。

2. **选择 AW 能力**
   - Skill：需要模型判断、可独立调用的工作流。
   - Extension：常驻规则、权限、hooks 或 agents。
   - Slash command：显式快捷入口。
   - MCP/App：工具或应用连接。
   - Dynamic artifact：由 AW config/renderer 生成的平台产物。
   - 详细项目 profile 见 `references/aw-authoring-profile.md`；按组件只读取对应 reference。

3. **组合通用作者能力**
   - 新建或重大变更 Skill：在 fresh context 中运行 `author-agent-skill`，输入已校验的 `SkillDesignBrief + AWAuthoringContext`。
   - AW adapter 拥有项目组合流程；`SkillDesignBrief.evalStageOwner` 必须是 `caller`，通用作者不得重复设计或审核 Eval。
   - invocation 映射：`model → model`，`manual → manual`，`claude-model-only → client-specific` 且目标只含 Claude。
   - 大量 AGENTS/README/prompt 改写：使用 `write-agent-content`。
   - 需要 Eval：fresh-context 运行 `design-agent-skill-evals`，再用另一个 fresh-context 运行 `audit-agent-skill-evals(preflight)`。
   - 具体子代理参数和生命周期由当前 runtime/harness 决定。本 Skill 只定义阶段输入输出。
   - Adapter 只消费结构化结果；结果无效时允许原 producer 修正一次，再次无效则停止阶段。

4. **集成 AW 源码**
   - 写入插件 source truth；不手改 generated runtime、catalog 或本地 cache。
   - Codex/Claude 平台元数据、静态/动态边界和 materialization 见 `references/aw-skill-integration.md`。

5. **版本、构建和确定性验证**
   - 已有插件的 production bundle 变化时，按兼容影响提高源码 manifest 稳定版本；仅作者期材料变化时不提高版本。
   - 需要时运行 `pnpm build`、项目 validator 和相关 deterministic tests。
   - 命令与完成边界见 `references/aw-validation-and-version.md`。

6. **Materialize 与模型证据**
   - Eval preflight 未通过时，不运行 release-relevant Eval，也不让失败驱动 Skill 修改。
   - 真实模型 Eval 由项目 CLI/harness 执行；本 Skill 只传递已审核 case 和授权。

7. **交付与后续项目写入**
   - 列出源码修改、manifest version、构建/验证、materialized artifacts、Eval audit 状态和未完成项。
   - 不输出独立 Review score、P0/P1 或 release pass。
   - 需要独立评审时交给 `review-aw-plugin`，不要在当前上下文自审。
   - Reviewer 发布报告后如用户要求登记 README，当前 Author 消费其结构化 registration request，更新 README 与 manifest version，并重新执行作者门禁。
