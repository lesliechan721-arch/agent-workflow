# Author AW Plugin 作者期评测

本目录由 `author-aw-plugin` 持有。`behavior-cases.json` 用 7 个复合请求检查 `AWAuthoringContext.components` 完整性、稳定 `aw plugin` 命令、Portable Agent Skills canonical reference、通用作者能力交接和 Author/Reviewer 边界。

```bash
pnpm plugin:eval aw-plugin-development --skill author-aw-plugin \
  --batch-name materialization --materialize-only
```

`evals/manifest.json` 是 release target 的真值。当前 `behavior` 和 `lightweight-delta` suite 都是 release-required；它们的空 `releaseSplits` 表示运行全部 case。

本轮只运行 materialize-only；该结果只提供最终制品物化证据，不提供模型行为或 release evidence。
