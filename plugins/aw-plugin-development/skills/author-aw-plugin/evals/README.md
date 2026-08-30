# Author AW Plugin 作者期评测

本目录由 `author-aw-plugin` 持有。`behavior-cases.json` 用 7 个复合请求检查 `AWAuthoringContext.components` 完整性、稳定 `aw plugin` 命令、Portable Agent Skills canonical reference、通用作者能力交接和 Author/Reviewer 边界。

```bash
aw skill eval prepare aw-plugin-development --skill author-aw-plugin \
  --suite behavior --profile project-default --output ./author-aw-plugin-plan --json
```

`evals/manifest.json` 是 release target 的真值。当前 `behavior` 和 `lightweight-delta` suite 都是 release-required；它们的空 `releaseSplits` 表示运行全部 case。

`prepare` 只提供输入完整的 Plan v4，不提供模型行为或 release evidence。真实执行必须由 Runner 完成 preflight Audit、授权、Bundle v4 validation 和 result triage。
