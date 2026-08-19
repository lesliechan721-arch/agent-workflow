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

## Standards and review handoff

`standards/skill-rules.json` 只维护 Skill/Eval 专属规则；`standards/rules.json` 是与 `agent-content-toolkit` 内容规则组合生成的运行视图。ReviewInputBundle v3 仅传 artifact metadata 和带 digest 的阶段引用，不内联 Eval audit 或 result body。

`validate-review-stage-result.mjs` 对 reusable stage 做确定性 admission：目标内容、producer、独立上下文、结果 schema、结果内容和 digest 必须一致。通用 Reviewer 的 behavior suite 是 diagnostic-only，只有真实重复运行、trace 和 grading 才能升级为发布证据。

## Validation

```bash
node scripts/generate-standard-views.mjs
node scripts/validate-standard-views.mjs
node scripts/generate-contract-assets.mjs
node scripts/validate-contract-assets.mjs
pnpm plugin:test agent-skill-toolkit
```
