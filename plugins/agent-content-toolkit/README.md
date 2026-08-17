# Agent Content Toolkit

用于创建和评审 Agent-facing 内容、Agent Skills 与 Skill Eval 的组合式工具包。

六个 Skill 分别拥有内容编写、内容评审、Skill 作者、Skill 评审、Eval 设计和 Eval 审核职责。安装后，模型可以根据用户意图选择其中一个能力，不需要加载整套方法。

## 安装

```bash
aw install agent-content-toolkit -p both
```

## 包含的 Skill

| Skill | 作用 | 写入 |
| --- | --- | --- |
| [`write-agent-content`](skills/write-agent-content/) | 创建或编辑 `AGENTS.md`、`CLAUDE.md`、prompt、role instruction 和 reference | 是 |
| [`review-agent-content`](skills/review-agent-content/) | 只读检查内容的指针、层级、控制、完成边界和可维护性 | 否 |
| [`author-agent-skill`](skills/author-agent-skill/) | 设计、创建或修改可复用 Agent Skill | 是 |
| [`review-agent-skill`](skills/review-agent-skill/) | 独立评审 Skill 的边界、触发、信息层级、脚本和发布准备度 | 否 |
| [`design-agent-skill-evals`](skills/design-agent-skill-evals/) | 设计或修改 trigger、behavior 和组合评测 | 是 |
| [`audit-agent-skill-evals`](skills/audit-agent-skill-evals/) | 运行前审核 Oracle，或运行后做失败归因 | 否 |

## 适合谁

- 维护仓库级 Agent 指令的团队。
- 创建可分发 Agent Skill 的作者。
- 需要证明 Skill 相比 baseline 确有增益的维护者。
- 希望将 Author 与 Reviewer 分开的项目。

## 设计边界

- 每次只加载当前任务需要的 Skill 和规则投影。
- Author 能修改目标，Reviewer 保持只读。
- 机械结构检查交给脚本，语义判断保留给模型和 Reviewer。
- Eval 先定义可观察 Oracle，再运行真实模型；失败先做归因，不直接堆叠新规则。

## 维护者

`standards/rules.json` 是共享质量规则源；各 Skill 使用面向自己职责的生成投影。检查生成内容和插件合同：

```bash
node scripts/validate-standard-views.mjs
node scripts/validate-contract-assets.mjs
pnpm plugin:test agent-content-toolkit
```
