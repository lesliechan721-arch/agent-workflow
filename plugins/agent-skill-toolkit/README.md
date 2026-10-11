# Agent Skill Toolkit

创建、维护、评审和简化 Agent Skill，并审核用例与组合架构。提供最小创建、静态检查和引用线索工具。

```sh
aw install agent-skill-toolkit -p codex
```

也支持 Claude，可将平台改为 `claude`。以上是 AW 分发安装方式，不是通用工具的运行依赖。使用其它方式取得完整包时，同时提供 `agent-content` 内容方法；单独复制源码目录不等于取得完整运行包。

| Skill | 用户结果 |
| --- | --- |
| author-agent-skill | 设计、创建、维护包；按需设计用例；完整委托下持续组织验证 |
| review-agent-skill | 单个 Skill 的只读质量判断 |
| simplify-agent-skill | 有限对照计划、候选和授权内接受改动 |
| audit-agent-skill-evals | 源用例审核、独立准入和结果解释 |
| review-agent-architecture | 有界工作流与公开入口架构判断 |

例如：“按这些日志样本创建摘要 Skill，不运行模型。”或“只读检查这个包是否有足够的方法与资源，不改文件。”局部错字直接处理，不要求额外设计文件。

作者和简化能力只写授权范围。评审不修改目标；报告可按请求保存。模型运行需兼容运行器、独立审核和明确预算；安装、提交和发布分别授权。静态检查不证明触发、任务效果或发布资格。
