# Review AW Plugin 作者期评测

本目录由 `review-aw-plugin` 持有。`behavior-cases.json` 用 6 个只读 case 检查 source/evidence
digest 边界、逐 Skill currentness、stage slot 冲突、materialized runtime closure 和分层 gate 聚合。

```bash
pnpm plugin:eval aw-plugin-development --skill review-aw-plugin \
  --batch-name materialization --materialize-only
```

`behavior` suite 是单次诊断资产，不进入 release gate。所有 case 要求 `workspace_unchanged=true`。
当前没有真实模型执行记录。
