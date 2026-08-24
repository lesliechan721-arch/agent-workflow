# Skill 标准

`agent-content-toolkit/standards/rules.json` 是所有 `agent.*` 与通用内容评审规则的唯一权威来源。

`skill-rules.json` 只维护：

- 对下层内容规则的 `skill_author`、`skill_review`、`eval_design`、`eval_audit` 投影；
- Skill/Eval 专属规则；
- Composition Fitness、Finding Admission 与 ReviewResult 决策策略。

`review-dimensions.json` 维护机器可读维度注册；`review-dimensions.md` 维护详细人类 rubric；`scoring-policy.md` 维护完整评分策略与 ReviewResult 决策边界。Skill 内的 generated 视图和评分规则只在 staging/runtime 由 build 生成，不作为 Git source 真值。

`generate-standard-views.mjs` 会验证下层规则 digest，拒绝上层重定义 canonical principle、evidence type 或 source refs，并生成动作视图、详细 rubric、评分文档和 `review-result-rules.generated.json`。
