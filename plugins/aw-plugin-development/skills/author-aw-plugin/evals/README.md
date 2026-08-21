# Author AW Plugin 作者期评测

本目录由 `author-aw-plugin` 持有。`behavior-cases.json` 用 6 个复合请求检查 `AWAuthoringContext.components` 完整性、稳定 `aw plugin` 命令、通用作者能力交接和 Author/Reviewer 边界。

```bash
pnpm plugin:eval aw-plugin-development --skill author-aw-plugin \
  --batch-name materialization --materialize-only
```

`behavior` suite 是单次诊断资产，不进入 release gate。本轮只运行 materialize-only；没有真实模型执行记录。
