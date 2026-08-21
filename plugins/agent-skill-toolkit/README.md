# agent-skill-toolkit

通用 Agent Skill 作者、评审和 Eval 设计/审核插件。

当前插件合同版本：`0.8.0`。

## 依赖

必需：`agent-content-toolkit >= 0.5.0`。

可选执行能力：`agent-skill-eval-runner >= 0.2.0`，或其它能消费 `EvalExecutionPlan` 并输出 `EvalRunBundle` 的 provider。本 toolkit 不执行高成本模型 Eval。

## 包含的 Skill

| Skill                      | 作用                                     | 权限 |
| -------------------------- | ---------------------------------------- | ---- |
| `author-agent-skill`       | 创建或变更完整 Agent Skill 包            | 写   |
| `review-agent-skill`       | 只读多维评审 Agent Skill 包              | 只读 |
| `design-agent-skill-evals` | 设计或修改 Skill Eval case/suite         | 写   |
| `audit-agent-skill-evals`  | 运行前审核 Oracle，运行后 failure triage | 只读 |

Author 不给自己的结果出独立发布结论；Eval Designer 不审核自己的 Oracle。

## 可移植合同

- `SkillDesignBrief`
- `SkillInspectionResult` v1：记录 source 或 materialized Skill 的生产 digest、传递 runtime closure 和不可忽略的机器 error。
- `ReviewInputBundle` v5：提供已验证的阶段交接、强制 `package-inspection`、精确的内联证据绑定和生产产物实体绑定。validator 会对目标 Skill 重新运行 canonical Inspector，拒绝手工删减的 inspection 结果。每个产物使用相对于绝对 `environment.repositoryRoot` 的权威 POSIX 路径、内容 digest 和规范化普通文件 mode（`100644` 或 `100755`）。必须提供 `target.currentness`。validator 根据 Git status、ignored file 和 index/worktree mode 推导生产产物与目标聚合 currentness；Git 无法证明 currentness 时，只允许 `unknown`。调用方必须在语义验证前，用真实工作区值替换模板中的 root 和 artifact。
- 带 `evalEvidenceLevel` 和 `machineEvidenceIds` 的 `ReviewResult` v4
- 同时绑定 Skill 和 case corpus digest 的 `EvalAuditResult` v2
- `EvalRuntimeCapabilities`
- `EvalExecutionPlan`
- `EvalRunBundle`

## 验证

```bash
node scripts/validate-review-input-bundle.mjs <bundle.json> --handoff-root <root>
node scripts/validate-review-result.mjs <review-result.json> --bundle <bundle.json>
pnpm plugin:test agent-skill-toolkit
```
