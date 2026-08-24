# Skill 标准

`agent-content-toolkit/standards/rules.json` 是所有 `agent.*` 与通用内容评审规则的唯一权威来源。

`skill-rules.json` 只维护：

- 对下层内容规则的 `skill_author`、`skill_review`、`eval_design`、`eval_audit` 投影；
- Skill/Eval 专属规则；
- Composition Fitness、Finding Admission 与 ReviewResult 决策策略。

`review-dimensions.json` 维护机器可读维度注册。详细人类 rubric 和评分策略直接由 `review-agent-skill` 维护。由共享规则渲染的动作视图只在 staging/runtime 构建，不作为 Git source 真值。

`generate-standard-views.mjs` 会验证下层规则 digest，拒绝上层重定义 canonical principle、evidence type 或 source refs，并渲染多个 Skill 共用的动作视图。
