# Agent Skill Toolkit

创建、维护、评审和简化 Agent Skill，并审核用例与组合架构。提供最小创建与静态包检查工具。

```sh
aw install agent-skill-toolkit -p codex
```

也支持 Claude，可将平台改为 `claude`。以上是 AW 分发安装方式，不是通用工具的运行依赖。使用其它方式取得完整包时，同时提供 `agent-content` 内容方法；单独复制源码目录不等于取得完整运行包。

| Skill | 用户结果 |
| --- | --- |
| author-agent-skill | 设计、创建、维护包和用例，完成当前修改的自检与修复 |
| review-agent-skill | 用户启动单个 Skill、工作流或公开能力组合的只读评审 |
| simplify-agent-skill | 用户启动有限对照计划、候选和授权内接受改动 |
| audit-agent-skill-evals | 源用例审核、独立准入和结果解释 |

例如：“按这些日志样本创建摘要 Skill，不运行模型。”局部错字直接处理，不要求额外设计文件。

专项评审和简化由用户选择启动时机。Codex 使用 `$review-agent-skill` 或 `$simplify-agent-skill`；Claude Code 使用 `/agent-skill-toolkit:review-agent-skill` 或 `/agent-skill-toolkit:simplify-agent-skill`。普通请求不会自动启动这两个入口。

可以请求“`$review-agent-skill` 只读检查这个包的方法与资源”，或“`$review-agent-skill` 评审这四个插件的交接与公开入口”，也可以用“`$simplify-agent-skill` 保留原版，只在候选目录删去重复，本次不运行模型”。作者自检与专项独立评审分别报告。

作者和简化能力只写授权范围。评审不修改目标；报告可按请求保存。模型运行需兼容运行器、独立审核和明确预算；安装、提交和发布分别授权。静态检查不证明触发、任务效果或发布资格。
