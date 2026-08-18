# agent-skill-toolkit

通用 Agent Skill 作者、评审和 Eval 工具插件。

## Manual dependency

当前要求人工同时安装 `agent-content-toolkit >= 0.2.0`。本插件不复制 Agent-facing 文档写作与 reference 审计流程；需要时调用依赖插件的 `write-agent-content` 或 `review-agent-content`。

## Skills

| Skill | 作用 | 默认权限 |
| --- | --- | --- |
| `author-agent-skill` | 创建或变更完整 Agent Skill 包 | 写 |
| `review-agent-skill` | 只读多维评审 Agent Skill 包 | 只读 |
| `design-agent-skill-evals` | 设计或修改 Skill Eval case / suite | 写 |
| `audit-agent-skill-evals` | 运行前审核 Oracle，或运行后做 failure triage | 只读 |

Author 不给自己的结果出独立发布结论；Eval Designer 不审核自己的 Oracle。

## Validation

```bash
node scripts/generate-standard-views.mjs
node scripts/validate-standard-views.mjs
node scripts/generate-contract-assets.mjs
node scripts/validate-contract-assets.mjs
pnpm plugin:test agent-skill-toolkit
```
