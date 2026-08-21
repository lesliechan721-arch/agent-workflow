# agent-skill-toolkit

通用 Agent Skill 作者、评审和 Eval 设计/审核插件。

Current plugin contract version: `0.7.1`.

## Dependency

Required: `agent-content-toolkit >= 0.5.0`.

Optional execution: `agent-skill-eval-runner >= 0.2.0` or another provider that consumes
`EvalExecutionPlan` and emits `EvalRunBundle`. The toolkit itself does not execute high-cost model
evals.

## Skills

| Skill                      | 作用                                     | 权限 |
| -------------------------- | ---------------------------------------- | ---- |
| `author-agent-skill`       | 创建或变更完整 Agent Skill 包            | 写   |
| `review-agent-skill`       | 只读多维评审 Agent Skill 包              | 只读 |
| `design-agent-skill-evals` | 设计或修改 Skill Eval case/suite         | 写   |
| `audit-agent-skill-evals`  | 运行前审核 Oracle，运行后 failure triage | 只读 |

Author 不给自己的结果出独立发布结论；Eval Designer 不审核自己的 Oracle。

## Portable contracts

- `SkillDesignBrief`
- `ReviewInputBundle` v4 with verified stage handoffs, exact inline evidence binding, and
  production artifact entity binding. Each artifact uses a canonical POSIX path relative to the
  absolute `environment.repositoryRoot`, a content digest, and normalized regular-file mode
  (`100644` or `100755`). `target.currentness` is required. The validator derives production
  artifact and aggregate target currentness from Git status, ignored files, and index/worktree
  modes; when Git cannot prove currentness, only `unknown` is valid. Callers must replace template
  roots and artifacts with real workspace values before semantic validation.
- `ReviewResult` v3 with `evalEvidenceLevel`
- `EvalAuditResult` v2 bound to both Skill and case corpus digests
- `EvalRuntimeCapabilities`
- `EvalExecutionPlan`
- `EvalRunBundle`

## Validation

```bash
node scripts/validate-review-input-bundle.mjs <bundle.json> --handoff-root <root>
pnpm plugin:test agent-skill-toolkit
```
