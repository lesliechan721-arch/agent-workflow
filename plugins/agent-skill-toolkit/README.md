# Agent Skill Toolkit

设计、创建、重构和只读评审 Agent Skill 及多 Skill 组合架构，并独立审核 Eval 用例与运行结果。随包提供最小创建与静态包检查工具。

```bash
aw target set codex
aw plugin install agent-skill-toolkit --scope user
```

安装目标包括 Codex、Claude Code、Antigravity、Cursor、OpenCode、Pi、GitHub Copilot CLI 和 Grok Build；`generic` 只输出通用 Skills。AW 按目标核对组件能力，并提示客户端无法保证的调用控制。依赖 `agent-content-toolkit` 提供通用内容写作与重构方法。

| Skill | 用户结果 |
| --- | --- |
| `agent-skill` | 设计、创建、修改、重构和只读评审单 Skill 或多 Skill 组合，并完成相称自检 |
| `audit-agent-skill-evals` | 独立只读审核 Eval 用例/Oracle、归因运行结果与执行正式运行准入 |

例如：“按这些真实踩坑记录创建部署检查 Skill，不运行模型。”、“重构这组 Skill，去掉抽象空话并合并薄壳入口。”、“只读评审这个插件的 Skill 边界和触发描述，不修改文件。”或“审核这套 Eval 用例的 Oracle 是否成立。”

`agent-skill` 按请求遵守写入或只读边界；`audit-agent-skill-evals` 始终保持对生产 Skill 与用例只读。模型运行需要兼容运行器、独立准入和明确预算；不会自动安装、提交或发布。
