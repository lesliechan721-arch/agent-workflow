---
name: review-aw-workflow
description: >-
  当用户明确要求只读审核一个跨多个 AW 插件或多个插件边界的既有工作流时使用；显式审核整仓 AW Agent 能力或多个尚未界定的 AW Agent 组件时也使用，但只做 Scope Admission 和 workflow partitions。负责发现 manifest dependency、三类 runtime import/export、profiles、materialized targets 和跨插件 handoff，并组合通用工作流评审。不修改插件，不评审单个插件内部实现；普通代码仓库 Review 不使用。
compatibility: bundled inventory script 需要 Node.js 22+；依赖 agent-skill-toolkit。
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

开始前明确用户结果、入口、参与插件、代表性路径、外部依赖、排除项和用户决策。触发本 Skill 不等于全局 scope 已准入。未界定的“评审整个仓库/平台”先列出 workflow partitions，本轮只能输出 `partial` 或 `rejected`；不得给全局 pass，也不得把分区局部结果合成为全局 pass。

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

2. 分别检查 `dependencyEdges`、`buildImportEdges`、`skillRuntimeFileImportEdges` 和 `artifactRuntimeImportEdges`，以及每类 `unresolved`、每类 `cycles`、products、runtime exports 和 materialized targets。不要把不同边合成一个依赖图。
3. 使用 `review-agent-workflow` 评审一个有界用户结果；传入 inventory、代表性 common path 和明确排除。
4. 只有 workflow finding 需要插件或 Skill 内部证据时，才调用 `review-aw-plugin` 或 `review-agent-skill`。父级负责跨插件 owner、blast radius 和最终 verdict。
5. 读取 `references/aw-workflow-review.md`，检查 AW 特有的 source/final、projection 和依赖问题。

## 输出

先报告 Scope status 和 inventory，再给 workflow design/complexity、跨插件 findings、Leaf Fix Admission 结果、最小架构、关键 unknown 和停止条件。没有 admitted scope 时必须列出 workflow partitions，只能给 `partial` 或 `rejected`，不得给完整或全局 pass。

## 可选报告归档

默认只在聊天中交付；只有用户明确要求归档时才写入。归档不改变 workflow findings、design 或 complexity，不自动运行 Eval 或 Release Check，也不更新 README。

生成 `scope.json` 前，先对每个 component 运行 `aw review digest <component-path> --json`，并把返回的 `path` 和 `digest` 原样写入对应 component；任一命令失败时停止，不得自行计算或猜测 digest。然后把 admitted scope 写成 `scope.json`：`schemaVersion: 1`、`kind: "aw-workflow"`、scope id、用户结果、入口、非空 components（每项含 kind/id/path/digest）、非空 representativePaths、externalDependencies 和 excluded。先运行 `aw review publish --help`；若未显示该子命令则停止。再用 `--kind aw-workflow --target <scope-id> --scope <scope.json> --report <report.md>` 发布已有材料；可附加已有 result、checks、evidence 或独立生成的 `release-check.json`。不得调用旧 `pnpm review:publish` 或旧 publisher。

`quick` 默认不归档，但用户明确要求时可以归档；`full` 可以归档；`delta` 必须创建新的不可变 record，并用 `--supersedes <review-id>` 指向同一 target 的旧 record。Release 不是 Review mode；Quality Review 不计算 readiness，独立 Release Check 只可作为附件。
