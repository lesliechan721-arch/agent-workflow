---
name: author-aw-plugin
description: >-
  当用户要创建或维护一个 AW 插件根、Skill、extension、MCP/App、slash command、dynamic artifact、稳定版本或构建验证时使用。目标根由 `.agents-plugin/plugin.json` 标识，可以位于任意兼容工作区；拥有插件源码写入和作者验证，不做独立质量评分或发布裁决。
compatibility: >-
  Requires Node.js 22+, the target workspace dependencies, agent-content-toolkit >= 0.2.0, and agent-skill-toolkit >= 0.2.0.
user-invocable: true
metadata:
  short-description: 创建或维护 AW 插件，并组合通用 Skill 作者与 Eval 设计能力
---

# Author AW Plugin

本 Skill 是 AW 插件作者适配器。通用 Agent Skill 与 Eval 标准由 `agent-skill-toolkit` 提供；当前 Skill 只负责 AW manifest、源码、README、构建、版本和 materialization。

## 依赖 Gate

需要时检查以下通用能力：

- `author-agent-skill`
- `design-agent-skill-evals`
- `audit-agent-skill-evals`

缺失时停止，不在本 Skill 中复制简化标准。人工安装是当前依赖保证；manifest 不声明 plugin dependency。

## 工作流

1. **确认目标和变更面**
   - 明确 `<plugin-root>` 与 `<workspace-root>`；插件根必须已有或将创建 `.agents-plugin/plugin.json`，但不要求固定目录名。
   - 读取 manifest、现有源码、目标工作区规则和允许修改文件。
   - 运行 `node scripts/prepare-aw-authoring-context.mjs <plugin-root> --repo-root <workspace-root> [options]`，并按 `assets/aw-authoring-context.schema.json` 校验输出。
   - 宿主工作区的 `docs/**` 不是本 Skill 的可移植作者合同；跨项目规则只能来自目标 manifest/schema、运行时工具或本 Skill 自带 reference。

2. **选择 AW 能力**
   - Skill：需要模型判断、可独立调用的工作流。
   - Extension：常驻规则、权限、hooks 或 agents。
   - Slash command：显式快捷入口。
   - MCP/App：工具或应用连接。
   - Dynamic artifact：由 AW config/renderer 生成的平台产物。
   - 详细 profile 见 `references/aw-authoring-profile.md`；按组件只读取对应 reference。
   - 新增、删除、重命名能力或改变用户可观察行为时，读取 `references/aw-readme-authoring.md`。

3. **组合通用作者能力**
   - 新建或重大变更 Skill：在 fresh context 中运行 `author-agent-skill`，输入已校验的 `SkillDesignBrief + AWAuthoringContext`。
   - AW adapter 拥有插件组合流程；`SkillDesignBrief.evalStageOwner` 必须是 `caller`，通用作者不得重复设计或审核 Eval。
   - invocation 映射：`model → model`，`manual → manual`，`claude-model-only → client-specific` 且目标只含 Claude。
   - 需要 Eval：fresh-context 运行 `design-agent-skill-evals`，再用另一个 fresh-context 运行 `audit-agent-skill-evals(preflight)`。
   - 具体子代理参数和生命周期由当前 runtime/harness 决定。本 Skill 只定义阶段输入输出。
   - Adapter 只消费结构化结果；结果无效时允许原 producer 修正一次，再次无效则停止阶段。

4. **集成 AW 源码与 README**
   - 写入插件 source truth；不手改 generated runtime、catalog 或本地 cache。
   - Codex/Claude 平台元数据、静态/动态边界和 materialization 见 `references/aw-skill-integration.md`。
   - 插件 README 与 Skill README 由当前 Skill 按 `references/aw-readme-authoring.md` 维护；不把普通 README 写作默认转交给通用 prompt/AGENTS 内容工作流。

5. **版本、构建和确定性验证**
   - 已有插件的 production bundle 变化时，按兼容影响提高源码 manifest 稳定版本；仅作者期材料变化时不提高版本。
   - 从目标工作区发现 build、test、materialization 和 release 命令；不要假设固定包管理器或 monorepo 路径。
   - 将发现到的确定性命令通过 `--validator` 写入 authoring context，再运行工作区要求的 tests。
   - 命令与完成边界见 `references/aw-validation-and-version.md`。

6. **Materialize 与模型证据**
   - Eval preflight 未通过时，不运行 release-relevant Eval，也不让失败驱动 Skill 修改。
   - 真实模型 Eval 由目标工作区 CLI/harness 执行；本 Skill 只传递已审核 case 和授权。

7. **交付与后续项目写入**
   - 列出源码修改、manifest version、构建/验证、materialized artifacts、Eval audit 状态和未完成项。
   - 不输出独立 Review score、P0/P1 或 release pass。
   - 需要独立评审时交给 `review-aw-plugin`，不要在当前上下文自审。
   - Reviewer 发布报告后如用户要求登记 README，当前 Author 消费其结构化 registration request，更新 README 与 manifest version，并重新执行作者门禁。
