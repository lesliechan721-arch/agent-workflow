# skill-review

面向 Agent Skill 的多维度、证据化、可计算评审包。

## 设计重点

- 12 个维度、总权重 100，评分、coverage、confidence 和发布门禁分离。
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
```

release 评审应按 `references/source-map.md` 重新核对当前官方 Agent Skills 文档。

当前仓库静态 Skill 的真实模型 eval 先运行 `pnpm build`，再由 `run_static_skill_evals.mjs` 生成证据；它不是 `plugin:eval` 的别名。
