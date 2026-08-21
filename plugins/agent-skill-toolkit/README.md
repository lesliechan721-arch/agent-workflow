# agent-skill-toolkit

通用 Agent Skill 作者、轻量评审和 Eval 设计/审核插件。

当前插件合同版本：`0.8.0`。

## 依赖

必需：`agent-content-toolkit >= 0.5.0`。

可选执行能力：`agent-skill-eval-runner >= 0.3.0`，或其它兼容 Eval provider。本 toolkit 不执行高成本模型 Eval。

## 包含的 Skill

| Skill                      | 作用                                     | 权限 |
| -------------------------- | ---------------------------------------- | ---- |
| `author-agent-skill`       | 创建或变更完整 Agent Skill 包            | 写   |
| `review-agent-skill`       | 只读、轻量评审 Agent Skill 包            | 只读 |
| `design-agent-skill-evals` | 设计或修改 Skill Eval case/suite         | 写   |
| `audit-agent-skill-evals`  | 运行前审核 Oracle，运行后 failure triage | 只读 |

Author 不给自己的结果出独立结论；Eval Designer 不审核自己的 Oracle。

## 默认 Review 路径

普通 `quick/full/delta` Review 只使用两个小型产物：

- `SkillCheckResult`：确定性检查 frontmatter、symlink 和传递 runtime closure；
- `ReviewResultLite`：目标 digest、设计结论、少量 findings 和关键 unknowns。

```bash
node scripts/check-agent-skill.mjs <skill-root> --output <check.json>
node scripts/validate-review-result-lite.mjs <review.json> --check <check.json>
```

设计质量与发布资格分离。模型 Reviewer 不维护 profile coverage、Git currentness、发布 gate 或多阶段状态；具体项目在发布时重新计算这些机器事实。

## 兼容合同

旧 `ReviewInputBundle`、`ReviewResult`、`SkillInspectionResult` 和相关 validator 暂时保留为迁移兼容接口，但不再由 `review-agent-skill` 默认路径加载或投影。新代码不应继续扩展旧 stage/gate 合同。

Eval 合同继续保留：`EvalAuditResult`、`EvalExecutionPlan`、`EvalRunBundle`。
