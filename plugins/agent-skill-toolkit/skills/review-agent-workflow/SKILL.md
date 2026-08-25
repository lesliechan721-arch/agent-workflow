---
name: review-agent-workflow
description: >-
  当用户明确要求只读审核一个由多个 Agent Skill、角色、工具、脚本或运行阶段共同完成的既有工作流时使用；显式审核整仓 Agent 能力或多个尚未界定的 Agent 组件时也使用，但只做 Scope Admission 和 workflow partitions。评估端到端路由、职责、handoff、状态与证据 owner、权限成本、失败传播和最小架构。不评审单个 Skill 包内部细节；普通代码仓库 Review 不使用。请求涉及 `.agents-plugin/plugin.json`、单个 AW 插件或跨 AW 插件时不使用，分别交给 `review-aw-plugin` 或 `review-aw-workflow`。
metadata:
  short-description: 只读评审有界的跨 Skill 工作流与最小架构
---

# Review Agent Workflow

完整评审对象是一个有界用户工作流。显式整仓 Agent 能力或多个未界定 Agent 组件的 Review 仍由本 Skill 接收，但本轮只做准入与分区。

## 依赖

- `review-agent-skill`：按需评审具体 leaf Skill。
- `review-agent-content`：按需评审大型 Agent-facing 文本或 handoff 文档。

## Scope Admission

开始前必须明确：

- 用户结果；
- 入口；
- 参与组件；
- 一条或几条代表性路径；
- 外部依赖；
- 明确排除；
- 用户要做的决策。

触发本 Skill 不等于全局 scope 已准入。无法建立边界时，先列出可独立评审的 workflow partitions；本轮只能输出 `partial` 或 `rejected`，不能给整个仓库或系统 `pass`，也不能把各分区的局部结果合成为全局 pass。

## 工作流

1. 写出真实 common path，不按现有目录或 schema 分段。
2. 读取 `references/workflow-review.md`，检查路由、职责、handoff、状态/证据 owner、权限/成本/失败传播和最小架构。
3. 参与组件较多且能按组件或证据域独立划分时，可以使用独立上下文子代理取证或做 leaf review。子代理不能给整个 workflow 结论；当前 Reviewer 负责 common path、owner、blast radius 和最终 verdict。
4. 建议修改 leaf Skill 前执行 Leaf Fix Admission：证明根因在 leaf 内部、识别直接消费者、说明公共行为变化，并排除更正确的 adapter/router/handoff/runtime 修复。
5. 比较一个同样安全的最小候选架构。可便宜重算的事实不应成为持久模型 handoff；optional branch 不应成为 common-path 成本。

## 输出

先报告：

```text
Scope status: admitted | partial | rejected
User outcome:
Entry:
Components:
Representative paths:
Excluded:
Unconfirmed dependencies:
```

只有 `admitted` 才能给完整 workflow verdict：

- `coherent | needs-fixes | redesign | blocked`
- `proportionate | over-specified | over-engineered`

随后列出必须处理的问题、最小架构方案、最多 3 项高价值改进、关键 unknown 和停止条件。每个 leaf 修改建议必须标明 owner 与 blast radius。

## 可选报告归档

默认只在聊天中交付；只有用户明确要求归档时才写入。归档不改变 workflow findings、design 或 complexity，不自动运行 Eval 或 Release Check，也不更新 README。

先把 admitted scope 写成 `scope.json`：`schemaVersion: 1`、`kind: "workflow"`、scope id、用户结果、入口、非空 components（每项含 kind/id/path/digest）、非空 representativePaths、externalDependencies 和 excluded。先运行 `aw review publish --help`；若未显示该子命令则停止。再用 `--kind workflow --target <scope-id> --scope <scope.json> --report <report.md>` 发布已有材料；可附加已有 result、checks、evidence 或独立生成的 `release-check.json`。不得调用旧 `pnpm review:publish` 或旧 publisher。

`quick` 默认不归档，但用户明确要求时可以归档；`full` 可以归档；`delta` 必须创建新的不可变 record，并用 `--supersedes <review-id>` 指向同一 target 的旧 record。Release 不是 Review mode；Quality Review 不计算 readiness，独立 Release Check 只可作为附件。
