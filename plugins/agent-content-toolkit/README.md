# agent-content-toolkit

通用 Agent 内容与 Agent Skill 工具包。

当前与仓库旧 Skill 并行存在。安装后，六个 Skill 可由模型按用户意图调用；它们不改变 AW 插件开发的仓库默认路由。

## Skills

| Skill | 作用 | 默认权限 |
| --- | --- | --- |
| `write-agent-content` | 创建或编辑 AGENTS.md、CLAUDE.md、prompt、role instruction、reference 等 Agent-facing 内容 | 写 |
| `review-agent-content` | 只读评审上述内容的指针、层级、控制、完成边界和可维护性 | 只读 |
| `author-agent-skill` | 创建或变更 Agent Skill 包 | 写 |
| `review-agent-skill` | 只读多维评审 Agent Skill 包 | 只读 |
| `design-agent-skill-evals` | 设计或修改 Skill Eval case / suite | 写 |
| `audit-agent-skill-evals` | 运行前审核 Oracle，或运行后做 failure triage | 只读 |

## 共享标准

`standards/rules.json` 是人工维护的唯一质量规则源。各 Skill 的 `*.generated.md` 是面向不同动作的精简投影；运行时不要求同时加载其它 Skill。

```bash
node scripts/generate-standard-views.mjs
node scripts/validate-standard-views.mjs
node scripts/generate-contract-assets.mjs
node scripts/validate-contract-assets.mjs
```

生成文件提交到仓库。CI 和 `pnpm plugin:test agent-content-toolkit` 只检查漂移，不自动改写。

```bash
pnpm plugin:test agent-content-toolkit
```
