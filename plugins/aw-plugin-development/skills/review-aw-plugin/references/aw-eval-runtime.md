# AW Eval runtime adapter

## Preconditions

- Eval corpus digest 有匹配的 `EvalAuditResult(validity=pass)`，才能作为 release evidence 或驱动 Skill 修改。
- 用户明确授权高成本模型运行和必要权限。
- project runner、materialization 和 process isolation 由 AW CLI 负责。

## Execution

```bash
pnpm plugin:eval <plugin> --skill <skill> --batch-name <name>
```

调试可选 suite/split/case；过滤运行形成 incomplete batch，不能直接作为完整 release evidence。

## Waiting

保留原进程 session，使用 harness 的响应式等待；不要用 `sleep`、`ps` 或报告文件轮询。超时不是 Eval 失败。

## Result

- `needs_review` 必须读取对应 trace。
- `incomplete` 或缺少定性复核不能形成 release pass。
- 结果交给 `audit-agent-skill-evals(result-triage)`，再决定是否存在 `skill-defect`。
