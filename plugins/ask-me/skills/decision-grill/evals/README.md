# Decision Grill 作者期评测

本目录由 `decision-grill` 持有。

```bash
pnpm plugin:eval ask-me --skill decision-grill --batch-name materialization --materialize-only
pnpm plugin:eval ask-me --skill decision-grill --batch-name release
```

单 Skill trigger
corpus 有 25 条用例：train 与 validation 各 10 条，另有 5 条 sanity。train/validation 各含 5 条隐式正例和 5 条近似负例；sanity 含显式调用、口语正例、短推荐、长上下文评审和完整实施任务。它覆盖计划、决策或想法访谈，以及一次性技术说明、直接推荐、内部执行计划和实施歧义等近似负例。`n09_implementation_ambiguity`
不加载项目规则，用于独立验证 description 边界；validation 和 sanity 负例零容忍。

`ask-me-routing-cases.json` 是两个 Ask Me Skill 的路由矩阵。它用 `expected_loaded_skills` 精确区分
`decision-grill`、`decision-prototype`
和不加载。核心 validation 和 sanity 用例都是发布门禁；每条运行 10 次，正确路由至少为 90%，任何同时加载都失败。

`decision-grill-release-evals.json`
包含 3 个低提示代表性会话用例，检查依赖前沿、用户所有的取舍、明确延后和最终确认。`natural-owner-choice`
只在 case 的 `workspace_files`
中提供已确认事实，用来验证 agent 先读项目文档、不重复询问，再把用户所有的取舍交给用户。它是发布必需的 behavior
suite。

`decision-grill-evals.json`
保留 15 个非发布诊断用例。多数用例隔离检查单条正文规则；`reopen-existing-decision`、`avoid-exhaustion`
和 `shared-understanding-confirmation` 使用低提示自然任务检查完整 Skill。它属于
`behavior-diagnostic` suite，不进入默认发布结果。conversation baseline 只移除 owner Skill，并保留
`decision-prototype`。
