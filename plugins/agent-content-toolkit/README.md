# agent-content-toolkit

创建和评审 Agent-facing 文档、Agent Skill 与 Skill Eval 的通用工具包。

## 什么时候使用

- 你要创建或修改 AGENTS.md、prompt、role instruction 或其它 Agent-facing 内容。
- 你要创建、修改或只读评审一个通用 Agent Skill 包。
- 你要设计 Skill Eval，或审核 Eval 的 Oracle、现实性和结果归因。

不适用于 `agent-workflows` 仓库专有的插件打包、版本、materialization 或发布工作流；这些任务使用 `aw-plugin-development`。

## 包含的 Skills

| Skill | 用途 | 调用方式 |
| --- | --- | --- |
| `write-agent-content` | 创建或编辑 Agent-facing 内容 | 自动或 `$write-agent-content` |
| `review-agent-content` | 只读评审 Agent-facing 内容 | 自动或 `$review-agent-content` |
| `author-agent-skill` | 创建或变更通用 Agent Skill | 自动或 `$author-agent-skill` |
| `review-agent-skill` | 只读评审通用 Agent Skill | 自动或 `$review-agent-skill` |
| `design-agent-skill-evals` | 设计或修改 Skill Eval | 自动或 `$design-agent-skill-evals` |
| `audit-agent-skill-evals` | 审核 Eval 或分析运行结果 | 自动或 `$audit-agent-skill-evals` |

## 快速开始

```bash
aw install agent-content-toolkit -p both -s user
```

示例请求：

- “为这个项目写一份简短、可执行的 AGENTS.md。”
- “创建一个只读审查数据库迁移计划的 Agent Skill，并设计最小 Eval。”
- “审核这些 trigger case 的 Oracle，先不要修改 Skill。”

## 平台与安装范围

支持 Codex 和 Claude Code 的 user scope 与 project scope。

## 权限和边界

- Author 和 Write Skills 可以修改用户指定的目标文件；Reviewer 和 Audit Skills 保持只读。
- Eval 设计 Skill 只创建或修改 Eval 资产，不运行高成本模型 Eval，也不据此修改生产 Skill。
- 工具包不执行 AW 项目专有的构建、materialization、版本递增或正式报告发布。
