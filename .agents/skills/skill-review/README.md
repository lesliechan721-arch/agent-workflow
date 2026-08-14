# skill-review

面向 Agent Skill 的多维度、证据化、可计算评审包。

## 设计重点

- 12 个维度、总权重 100，评分、coverage、confidence 和发布门禁分离；最小充分控制为独立高权重维度。
- 人读主报告采用行动优先结构；完整执行审计，但只按 finding、决策关键 unknown 和结论变化向主报告展示异常。
- 顶层分开报告设计结论、发布就绪度、复杂度和证据状态；不再使用 `pass-after-fixes` 混合设计缺陷与证据缺口。
- full/release 使用 `review.md`、`review-appendix.md` 和 `scorecard.json` 三个制品；总分、完整 gate、12 维、admission 和专项审计不进入主报告顶层。
- 未指定深度、评分或发布判断的普通评审默认使用 quick；full 只用于明确要求的完整多维评审。
- 被审材料按不可信数据处理；先核验强证据，再做 heuristic/inferred 设计审视。
- P0/P1 通过主 `SKILL.md` 中统一的 exact claim、重要前提、reachability、impact 和反证 gate；finding/unknown 先于评分；总分不决定发布；quick/delta 不计算总分。
- 审核 description 及其它 context pointer 的触发 branch，而不仅是关键词。
- 区分 in-file step、in-file reference、disclosed reference 和 environment lookup。
- 检查步骤完成边界的清晰度、可检查性、覆盖要求和提前结束风险。
- 在完成边界前先建立最小行为合同，判断现有阶段、门禁和 artifact 是否有必要。
- 独立报告 `minimal`、`proportionate`、`over-specified` 或 `over-engineered`，并用复杂度上限校准总体质量。
- 区分 duplication、scattering 和 co-location。
- 将官方规范、包内结构问题、第三方 heuristic 和 reviewer 推演分开定级。
- 通过 delta review、ablation 和 stop decision 防止 Skill 只增不减。
- 静态控制面计数只触发语义审计，不自动判定缺陷。
- 存在 eval 时先审 suite、错误代价、case 层级、oracle 和现实性，再解释运行结果。
- 用 `eval-validity` 和 `eval-change-safety` 阻止错误 oracle、混合低样本结果或单 case 过拟合驱动 Skill 修改。

## 使用

```bash
node scripts/inspect_skill_target.mjs /path/to/skill --format json
node scripts/validate_eval_cases.mjs /path/to/eval-cases.json --format json
cp assets/scorecard-template.json review.json
node scripts/validate_scorecard.mjs review.json --format json
node scripts/run_static_skill_evals.mjs <skill-name-or-dir> --validate-only
pnpm review:publish -- --skill <skill> [--plugin <plugin>] --batch-id <id> \
  --report <report.md> --scorecard <scorecard.json>
pnpm review:release -- --skill <skill> [--plugin <plugin>] --batch-id <id>
```

release 评审应按 `references/source-map.md` 重新核对当前官方 Agent Skills 文档。

`validate_eval_cases.mjs` 默认兼容历史 case：确定性结构错误会失败，缺少发布级 audit metadata 只给 warning。只对已经选定为发布或修改依据的 case 文档使用 `--strict`。

当前仓库静态 Skill 的真实模型 eval 先运行 `pnpm build`，再由 `run_static_skill_evals.mjs` 生成证据；它不是 `plugin:eval` 的别名。

评审默认只返回结果。用户只要求保存草稿时写入 `.tmp/agent-workflows/reviews/`。`review:publish` 只在用户明确要求正式发布时生成报告并封存批次；它不更新 Skill README。README 登记需要用户另行明确要求，再运行 `review:release`。静态和插件目标的目录及证据规则分别见 `references/static-skill-evaluation.md` 和 `references/agent-workflows-plugin.md`。

## 最近登记

- 最近登记的正式报告：暂无。正式报告发布与 README 登记分离；是否存在未登记报告以 `.agents/reports/skill-review/` 为准。
