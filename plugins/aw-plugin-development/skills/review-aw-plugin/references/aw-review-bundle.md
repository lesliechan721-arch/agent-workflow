# AW ReviewInputBundle

## Artifact roles

- `source`：插件源码、静态 Skill 或动态模板。
- `final`：中央 materializer 生成的 project/user 最终制品。
- `evidence`：deterministic test、EvaluationBundle、trace、正式 summary。
- `project-profile`：manifest、config、renderer、源码稳定版本和平台约束。

每个 artifact 记录 path、profile、digest、currentness 和 owner。动态 Skill 不用源码占位文本代替最终制品。

使用准备脚本：

```bash
node scripts/prepare-aw-review-bundle.mjs plugins/<name> \
  --source agent-content-toolkit=plugins/agent-content-toolkit \
  --final codex-project=<materialized-dir> \
  --eval-audit <eval-audit-result.json> \
  --eval-case <trigger-cases.json> \
  --eval-result <evaluation.json>
```

`--source name=path` 必须覆盖当前 review/eval batch 的全部 participant 插件。脚本按与 `review:publish` 相同的作者源码 digest 合同绑定这些根目录；漏掉 companion source 会使发布前 digest 校验失败。

没有提供 final 或 evidence 时，bundle 必须明确缺失，不得从 source 推断。脚本输出后，用 `assets/review-input-bundle.schema.json` 校验。
