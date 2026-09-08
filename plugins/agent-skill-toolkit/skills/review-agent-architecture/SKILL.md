---
name: review-agent-architecture
description: >-
  当用户明确要求只读审核多个 Agent Skill、插件、角色、工具、脚本或运行阶段组成的有界 workflow，或审核一个插件/工具集的公开 Skill surface、facade、依赖和组合架构时使用。评估路由、职责、handoff、状态/证据 owner、权限成本、失败传播、context/cognitive load 和最小架构；不修改目标，不代替单 Skill 内部 Review。
metadata:
  short-description: 评审跨 Skill workflow 与插件 public surface 架构
---

# Review Agent Architecture

评审对象必须是有界 workflow 或 portfolio。

## Scope Admission

开始前明确：用户结果或 portfolio 决策、入口、参与组件、代表性路径、外部依赖、排除项和未确认能力。无法建立边界时只输出 partitions 和 `partial/rejected`，不给全局 pass。

## 路径

- **workflow**：检查一条或几条用户 common path。
- **portfolio**：检查 plugins、public Skills、manual macros、facades、dependencies 和安装/发现面。

## 依赖

- 具体 leaf Skill 使用 `review-agent-skill`；
- 大型 Agent-facing 内容使用 `agent-content`；
- 父 Reviewer保留跨组件 owner、blast radius 和最终 verdict。

涉及 Skill 调用与可用性读取 `references/skill-invocation.md`；涉及 caller/leaf、输出或独立上下文读取 `references/skill-composition.md`。

## 工作流

1. 读取 `references/architecture-review.md`，按真实用户路径而不是目录分段。
2. Portfolio 读取 `references/public-surface-review.md`，先归并用户 intent families，再审每个 public Skill 的准入。
3. 按共享调用标准核对目标 harness 能力与实际可达路径；安装依赖、文件存在和已加载状态分别取证。
4. 按共享组合标准核对输出用途和独立证据，避免重复建立协议。
5. 大量独立证据域可使用 fresh-context 子代理；子代理只取证或 leaf review，不给全局结论。
6. 建议修改 leaf 前证明根因在 leaf，并排除 facade/router/adapter/runtime 修复。
7. 给出同样安全的更短架构，比较 public surface、active-path context、handoff、权限和失败传播。

## 输出

先报告 scope status。admitted 时给：

- workflow/portfolio verdict：coherent | needs-fixes | redesign | blocked；
- public surface：coherent | facade-needed | fragmented | monolithic；
- plugin boundaries：coherent | merge-candidate | split-candidate；
- 必须处理、最小架构、最多 3 项高价值改进、关键 unknown 和停止条件。

用户明确要求归档且本 Skill 是本次顶层 Reviewer 时，读取 `references/report-publication.md`。需要包级合同消费者线索时，可使用 `scripts/audit-output-contracts.mjs` 扫描明确范围；静态搜索结果不是自动删除结论。
