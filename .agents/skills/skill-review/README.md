# skill-review

面向 Agent Skill 的多维度、证据化、可计算评审包。

## 设计重点

- 12 个维度、总权重 100，评分、coverage、confidence 和发布门禁分离。
- 被审材料按不可信数据处理；先核验强证据，再做 heuristic/inferred 设计审视。
- P0/P1 通过反证 gate；finding/unknown 先于评分；总分不决定发布；quick/delta 不计算总分。
- 审核 description 及其它 context pointer 的触发 branch，而不仅是关键词。
- 区分 in-file step、in-file reference、disclosed reference 和 environment lookup。
- 检查步骤完成边界的清晰度、可检查性、覆盖要求和提前结束风险。
- 区分 duplication、scattering 和 co-location。
- 将官方规范、包内结构问题、第三方 heuristic 和 reviewer 推演分开定级。
- 通过 delta review、ablation 和 stop decision 防止 Skill 只增不减。

## 使用

```bash
node scripts/inspect_skill_target.mjs /path/to/skill --format json
cp assets/scorecard-template.json review.json
node scripts/validate_scorecard.mjs review.json --format json
node scripts/run_static_skill_evals.mjs <skill-name-or-dir> --validate-only
pnpm review:publish -- --skill <skill> [--plugin <plugin>] --batch-id <id> \
  --report <report.md> --scorecard <scorecard.json>
```

release 评审应按 `references/source-map.md` 重新核对当前官方 Agent Skills 文档。

当前仓库静态 Skill 的真实模型 eval 先运行 `pnpm build`，再由 `run_static_skill_evals.mjs` 生成证据；它不是 `plugin:eval` 的别名。

完整 eval/review 批次保存在 `.tmp/agent-workflows/evals/`。`review:publish` 生成的静态 Skill 正式报告位于 `.agents/reports/<skill>/<batch-id>/`，插件 Skill 正式报告位于 `plugins/<plugin>/reports/<skill>/<batch-id>/`；每个正式目录只含 `report.md` 和 `summary.json`。

Skill README 中的最近正式报告摘要、仓库相对路径和被评估 Git commit 由作者或 agent 在 `review:publish` 后人工更新。程序不写 marker、不自动同步，也不把该段内容作为发布门禁。

## 最近验证

- 最近正式报告：暂无。
