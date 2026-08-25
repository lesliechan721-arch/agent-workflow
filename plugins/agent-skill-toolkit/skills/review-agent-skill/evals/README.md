# Reviewer 行为评测

`behavior-cases.json` 是作者期的结构与设计证据。它定义可观察场景、Oracle 和人工语义 checks，但当前没有真实模型执行证据，也不得据此声称行为已通过。

只物化最终制品并验证合同：

```bash
pnpm plugin:eval agent-skill-toolkit --skill review-agent-skill --batch-name reviewer-structural --materialize-only
```

行为 suite 是 manifest 声明的 release-required 证据（`requiredForRelease: true`、`releaseSplits: []`、`defaultRuns: 1`）。conversation driver 不支持 split 过滤，因此 `releaseSplits` 保持空数组。
