# Eval 审核器行为评测

`behavior-cases.json` 是作者期的结构与设计证据。它定义 fail-closed、digest binding 和结果归因场景，但当前没有真实模型执行证据，也不得据此声称行为已通过。

只物化最终制品并验证合同：

```bash
pnpm plugin:eval agent-skill-toolkit --skill audit-agent-skill-evals --batch-name auditor-structural --materialize-only
```

行为 suite 不参与 release gate（`requiredForRelease: false`、`releaseSplits: []`、`defaultRuns: 1`）。
