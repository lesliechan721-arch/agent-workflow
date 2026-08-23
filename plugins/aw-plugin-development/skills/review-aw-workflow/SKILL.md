---
name: review-aw-workflow
description: >-
  当用户明确要求只读审核一个跨多个 AW 插件或多个插件边界的既有工作流时使用。目标必须有明确用户结果、入口和参与插件；负责发现 manifest、插件依赖、runtime imports/exports、profiles、materialized targets 和跨插件 handoff，并组合通用工作流评审。不修改插件，不评审单个插件内部实现，也不对未界定的整个仓库给出完整结论。
compatibility: bundled inventory script 需要 Node.js 22+；依赖 agent-skill-toolkit >= 0.1.0。
user-invocable: true
metadata:
  short-description: 只读评审有界的跨 AW 插件工作流
---

# Review AW Workflow

## 依赖

- `review-agent-workflow`：判断端到端路由、职责、handoff、状态 owner、失败传播与最小架构。
- `review-aw-plugin`：按需评审单个参与插件。
- `review-agent-skill`：按需评审具体 leaf Skill。

## Scope Admission

开始前明确用户结果、入口、参与插件、代表性路径、外部依赖、排除项和用户决策。未界定的“评审整个仓库/平台”先拆成 workflow 分区，不给全局 pass。

## 工作流

1. 运行确定性 inventory：

   ```bash
   node scripts/discover-aw-workflow.mjs \
     --entry <plugin-or-skill> \
     --plugin <plugin-root> \
     [--plugin <another-plugin-root>]... \
     [--materialized <plugin=profile=skills-root>]... \
     --format json
   ```

2. 检查 manifest name、skills、products、runtime exports/imports、提供的 materialized targets、未解析依赖和插件依赖环。
3. 使用 `review-agent-workflow` 评审一个有界用户结果；传入 inventory、代表性 common path 和明确排除。
4. 只有 workflow finding 需要插件或 Skill 内部证据时，才调用 `review-aw-plugin` 或 `review-agent-skill`。父级负责跨插件 owner、blast radius 和最终 verdict。
5. 读取 `references/aw-workflow-review.md`，检查 AW 特有的 source/final、projection 和依赖问题。

## 输出

先报告 Scope status 和 inventory，再给 workflow design/complexity、跨插件 findings、Leaf Fix Admission 结果、最小架构、关键 unknown 和停止条件。没有 admitted scope 时不得给完整 pass。
