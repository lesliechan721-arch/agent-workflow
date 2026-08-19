# AW ReviewInputBundle

## Target

This adapter accepts only an AW plugin root containing `.agents-plugin/plugin.json`. Portable or repo-local Agent Skills use `review-agent-skill` directly.

## Artifact roles

- `source`：插件源码或动态模板。
- `final`：中央 materializer 生成的 project/user 最终制品。
- `evidence`：deterministic test、EvaluationBundle、trace、正式 summary。
- `project-profile`：manifest、config、renderer、源码稳定版本和平台约束。

每个 artifact 记录 path、profile、digest、currentness 和 owner。动态 Skill 不用源码占位文本代替最终制品。

```bash
node scripts/prepare-aw-review-bundle.mjs plugins/<name> \
  --source agent-content-toolkit=plugins/agent-content-toolkit \
  --source agent-skill-toolkit=plugins/agent-skill-toolkit \
  --final codex-project=<materialized-dir> \
  --eval-audit <eval-audit-result.json> \
  --eval-case <trigger-cases.json> \
  --eval-result <evaluation.json>
```

`--source name=path` 覆盖当前 review/eval batch 的全部 participant 插件。漏掉 companion source 会使发布前 digest/currentness 证据不完整。

`providedStages` 只记录真实完成的审核阶段。每条记录必须包含 stage id、producer、independent context、target digest、result path/digest 和 schema。`--final` 只增加 final artifacts，绝不自动增加 `materialized-profile-review`。

没有提供 final 或 evidence 时，bundle 明确缺失，不从 source 推断。脚本输出后按 `assets/review-input-bundle.schema.json` 校验。
