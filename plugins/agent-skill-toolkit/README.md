# agent-skill-toolkit

通用 Agent Skill 作者、评审和 Eval 工具插件。

## Manual dependency

当前要求人工同时安装 `agent-content-toolkit >= 0.3.0`。该插件拥有 `agent.*` 和通用内容评审规则；本插件只维护 Skill/Eval 专属规则与动作投影，不复制下层 principle、证据分类或 source refs。

## Skills

| Skill | 作用 | 默认权限 |
| --- | --- | --- |
| `author-agent-skill` | 创建或变更完整 Agent Skill 包 | 写 |
| `review-agent-skill` | 只读多维评审 Agent Skill 包 | 只读 |
| `design-agent-skill-evals` | 设计或修改 Skill Eval case / suite | 写 |
| `audit-agent-skill-evals` | 运行前审核 Oracle，或运行后做 failure triage | 只读 |

Author 不给自己的结果出独立发布结论；Eval Designer 不审核自己的 Oracle。

## Standards

- `agent-content-toolkit/standards/rules.json`：内容层唯一来源。
- `standards/skill-rules.json`：Skill/Eval overlay、Composition Fitness、Finding Admission 和 ReviewResult policy。
- `standards/review-dimensions.json`：机器可读维度注册。
- `standards/review-result-rules.generated.json`：validator 的生成输入。

## Validation

```bash
node scripts/generate-standard-views.mjs
node scripts/validate-standard-views.mjs
node scripts/generate-contract-assets.mjs
node scripts/validate-contract-assets.mjs
pnpm plugin:test agent-skill-toolkit
```
