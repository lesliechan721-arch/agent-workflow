# Agent Skill Toolkit

创建、评审和简化 Agent Skill，并审核 Eval 与跨组件架构。安装时会同时满足 `agent-content-toolkit` 依赖。

```bash
aw install agent-skill-toolkit --scope user --target codex
```

也支持 Claude Code，可改用 `--target claude-code`。

| Skill | 适用任务 |
| --- | --- |
| `author-agent-skill` | 创建或修改 Skill 包，也可设计 Eval 用例 |
| `review-agent-skill` | 只读评审一个 Skill |
| `simplify-agent-skill` | 用固定对照简化已有 Skill |
| `audit-agent-skill-evals` | 独立审核 Oracle，或解释已有结果 |
| `review-agent-architecture` | 评审多组件工作流和公开能力边界 |

例如：“为这项任务创建最小 Skill，并设计主要场景的用例。”或“只读检查这组 Skill 是否有重复入口。”普通协作不要求中间设计 JSON；用户指定的格式和真实消费者合同仍可使用。

作者与简化能力只写授权范围。评审和审核保持目标只读，可按请求写入指定报告文件；项目归档由相应调用方完成。真实模型执行需要兼容运行器、独立审核和成本授权；本插件不自行发布项目。源码用例审核不要求 AW 环境。
