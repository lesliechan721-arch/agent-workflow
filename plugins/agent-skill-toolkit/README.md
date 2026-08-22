# agent-skill-toolkit

通用 Agent Skill 作者、轻量质量评审和 Eval 设计/审核插件。

## 依赖

必需：`agent-content-toolkit >= 0.1.0`。

可选执行能力：`agent-skill-eval-runner >= 0.1.0`，或其它兼容 Eval provider。本 toolkit 不执行高成本模型 Eval。

## 包含的 Skill

| Skill | 作用 | 权限 |
| --- | --- | --- |
| `author-agent-skill` | 创建或变更完整 Agent Skill 包 | 写 |
| `review-agent-skill` | 只读评审单个 Skill 或端到端 Skill 组合的质量与复杂度 | 只读 |
| `design-agent-skill-evals` | 设计或修改 Skill Eval case/suite | 写 |
| `audit-agent-skill-evals` | 运行前审核 Oracle，运行后 failure triage | 只读 |

Author 不给自己的结果出独立质量结论；Eval Designer 不审核自己的 Oracle。

## 轻量 Review 合同

默认评审产物是人类可读报告。确定性包事实由 `check-agent-skill.mjs` 直接计算；需要自动化交接时，使用 `ReviewResultLite` v1。

系统级评审不增加新的 handoff schema。Reviewer 先识别 `skill | workflow | plugin | system` 层级，再把 common path、可重算状态、state owner、持久合同和 validator 一并纳入 End-to-End Minimum Architecture Challenge。若存在显著更简单且同样可靠的方案，可以直接输出 `design=redesign`、`complexity=over-engineered`，无需伪造高严重性缺陷。

`ReviewResultLite` 只保存：

- 一个 target digest；
- 一个 `quick | full | delta` 模式；
- 一个 design 和一个 complexity 结论；
- 一段摘要；
- 最少必要的 findings 与 unknowns；
- 可用的 Eval evidence level。

它不保存多阶段 handoff、发布 readiness、profile coverage、加权分数或机器错误副本。旧 `ReviewInputBundle` / `ReviewResult` 合同暂时作为迁移兼容 export 保留，但不再投影到 `review-agent-skill` 的运行包，也不是新流程的默认接口。

## 验证

```bash
node scripts/check-agent-skill.mjs <skill-root> --format json --output check.json
node scripts/validate-review-result-lite.mjs review.json --check check.json
pnpm plugin:test agent-skill-toolkit
```
